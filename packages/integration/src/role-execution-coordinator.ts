import {
  type AssuranceService,
  type CheckDefinitionV1,
  type EvidenceRecord,
  type EvidenceStorePort,
  formatEvidenceRef,
} from "@emi-harness/assurance";
import {
  canonicalizeJson,
  digestJson,
  type Actor,
  type JsonValue,
  type RolePlan,
  type RoleRun,
  type RunManifestV1,
  type SqliteControlPlane,
  type VersionedRef,
} from "@emi-harness/control-plane";
import type { FileResourceRegistry } from "@emi-harness/resource-registry";
import type {
  PiRuntimePort,
  RuntimeEvent,
  RuntimeResourceSnapshot,
  RuntimeRunResult,
  RuntimeSession,
  RuntimeTextResource,
  RuntimeThinkingLevel,
  RuntimeTool,
} from "@emi-harness/runtime-pi";
import {
  LOCAL_WORKSPACE_ISOLATION_REF,
  type OperationResult,
  type SqliteToolGateway,
  WORKSPACE_WRITE_TOOL_REF,
} from "@emi-harness/tool-gateway";

import { fail } from "./errors.js";
import { GatewayRuntimeToolCollector } from "./gateway-runtime-tool.js";
import {
  assertToolRef,
  ExecutionSubmissionCollector,
  SUBMIT_EXECUTION_TOOL_REF,
  SUBMIT_VERIFICATION_TOOL_REF,
  VERIFIER_READONLY_ISOLATION_REF,
  VerificationSubmissionCollector,
} from "./submission-tools.js";
import type {
  ExecuteRoleOutcome,
  ExecuteRoleRequest,
  UnsuccessfulRole,
  VerificationSubmission,
  VerifyRoleOutcome,
  VerifyRoleRequest,
} from "./types.js";

export interface RoleExecutionCoordinatorConfig {
  controlPlane: SqliteControlPlane;
  runtime: PiRuntimePort;
  resourceRegistry: FileResourceRegistry;
  toolGateway: SqliteToolGateway;
  assurance: AssuranceService;
  evidenceStore: EvidenceStorePort;
  coordinator: Actor;
}

interface StartedRole {
  manifest: RunManifestV1;
  manifestDigest: string;
  rolePlan: RolePlan;
  roleRun: RoleRun;
  leaseToken: number;
  session: RuntimeSession;
}

interface RuntimeObservation {
  result: RuntimeRunResult;
  events: readonly RuntimeEvent[];
}

interface SettledToolEvidence {
  operationIds: readonly string[];
  evidenceRefs: readonly string[];
  actualChangedPaths: readonly string[];
  unknown: boolean;
  snapshots: readonly {
    operationId: string;
    status: string;
    result?: OperationResult;
  }[];
}

const THINKING_LEVELS = new Set<RuntimeThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function toJson(value: unknown): JsonValue {
  return JSON.parse(canonicalizeJson(value)) as JsonValue;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}\u0000${ref.version}\u0000${ref.digest}`;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return refKey(left) === refKey(right);
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function eventEvidence(event: RuntimeEvent): JsonValue {
  const common = {
    type: event.type,
    sourceType: event.sourceType,
    runId: event.runId,
    roleRunId: event.roleRunId,
    role: event.role,
    sessionId: event.sessionId,
  };
  if (event.type === "tool.started" || event.type === "tool.updated" || event.type === "tool.completed") {
    return {
      ...common,
      callId: event.callId,
      toolName: event.toolName,
      ...(event.type === "tool.completed" ? { isError: event.isError } : {}),
    };
  }
  if (event.type === "agent.ended") {
    return {
      ...common,
      outcome: event.outcome,
      willRetry: event.willRetry,
    };
  }
  if (event.type === "retry.started") return { ...common, attempt: event.attempt, maxAttempts: event.maxAttempts };
  if (event.type === "retry.completed") return { ...common, attempt: event.attempt, success: event.success };
  if (event.type === "compaction.started" || event.type === "compaction.completed") {
    return { ...common, reason: event.reason };
  }
  return common;
}

export class RoleExecutionCoordinator {
  private readonly controlPlane: SqliteControlPlane;
  private readonly runtime: PiRuntimePort;
  private readonly resources: FileResourceRegistry;
  private readonly gateway: SqliteToolGateway;
  private readonly assurance: AssuranceService;
  private readonly evidence: EvidenceStorePort;
  private readonly coordinator: Actor;

  constructor(config: RoleExecutionCoordinatorConfig) {
    if (config.coordinator.actorType !== "agent" && config.coordinator.actorType !== "system") {
      fail("invalid_configuration", "Role coordinator must be a system or coordinator agent actor");
    }
    this.controlPlane = config.controlPlane;
    this.runtime = config.runtime;
    this.resources = config.resourceRegistry;
    this.gateway = config.toolGateway;
    this.assurance = config.assurance;
    this.evidence = config.evidenceStore;
    this.coordinator = config.coordinator;
  }

  async execute(request: ExecuteRoleRequest): Promise<ExecuteRoleOutcome> {
    const task = this.controlPlane.getTask(request.taskId);
    const run = this.controlPlane.getRun(request.runId);
    const manifestRecord = this.controlPlane.getRunManifest(request.runId);
    const rolePlan = this.requireRolePlan(manifestRecord.manifest, request.rolePlanId, "executor");
    const collector = new ExecutionSubmissionCollector();
    const gatewayTools = new GatewayRuntimeToolCollector(this.gateway);
    const prepared = this.controlPlane.prepareRoleRun({
      commandId: `${request.roleRunId}:prepare`,
      actor: this.coordinator,
      taskId: request.taskId,
      expectedTaskVersion: task.version,
      runId: request.runId,
      expectedRunVersion: run.version,
      roleRunId: request.roleRunId,
      rolePlanId: request.rolePlanId,
      inputArtifacts: [manifestRecord.manifest.inputs.trd, manifestRecord.manifest.inputs.executionPlan],
    });
    const leased = this.controlPlane.acquireRoleRunLease({
      commandId: `${request.roleRunId}:lease`,
      actor: request.worker,
      taskId: request.taskId,
      expectedTaskVersion: task.version,
      runId: request.runId,
      expectedRunVersion: run.version,
      roleRunId: request.roleRunId,
      expectedRoleRunVersion: prepared.version,
      leaseOwner: request.worker.actorId,
      leaseDurationMs: this.leaseDuration(request.leaseDurationMs, rolePlan.limits.timeoutMs),
    });
    const tools = this.executorTools(rolePlan, collector, gatewayTools, {
      runId: request.runId,
      roleRunId: request.roleRunId,
      leaseToken: leased.roleRun.leaseToken,
    });
    const started = await this.startRuntime(
      request,
      manifestRecord.manifest,
      manifestRecord.digest,
      rolePlan,
      leased.roleRun,
      tools,
    );
    const runtime = await this.runRuntime(started.session, request.prompt, rolePlan.limits.timeoutMs);
    const operationIds = gatewayTools.operationIds();
    const settling = this.controlPlane.markRoleRunSettling({
      commandId: `${request.roleRunId}:runtime-settled`,
      actor: request.worker,
      roleRunId: request.roleRunId,
      expectedRoleRunVersion: started.roleRun.version,
      leaseToken: started.leaseToken,
      runtimeOutcome: runtime.result.outcome,
      toolOperationRefs: operationIds,
    });
    const runtimeEvidence = this.saveRuntimeEvidence(request, started, runtime);
    const runtimeEvidenceRef = formatEvidenceRef(runtimeEvidence);
    const toolEvidence = await this.settleToolEvidence(request, started, operationIds);
    const evidenceRefs = [runtimeEvidenceRef, ...toolEvidence.evidenceRefs];
    if (toolEvidence.unknown) {
      return this.blockRole(
        request,
        started.session.sessionId,
        settling,
        evidenceRefs,
        "unknown_tool_operation",
        request.worker,
      );
    }
    if (runtime.result.outcome !== "completed") {
      return this.failRole(request, started.session.sessionId, settling, evidenceRefs, runtime.result.outcome, request.worker);
    }

    let submission;
    try {
      submission = collector.requireSingle();
    } catch {
      return this.failRole(request, started.session.sessionId, settling, evidenceRefs, "invalid_execution_submission", request.worker);
    }
    if (!exactStrings(submission.changedPaths, toolEvidence.actualChangedPaths)) {
      return this.failRole(
        request,
        started.session.sessionId,
        settling,
        evidenceRefs,
        "changed_path_binding_mismatch",
        request.worker,
      );
    }

    const executionContent = {
      schemaVersion: "1",
      taskId: request.taskId,
      runId: request.runId,
      manifestDigest: started.manifestDigest,
      baseCommit: started.manifest.target.baseCommit,
      roleRunId: request.roleRunId,
      sessionId: started.session.sessionId,
      summary: submission.summary,
      changedPaths: [...submission.changedPaths].sort(),
      selfChecks: [...submission.selfChecks],
      workspaceOutputDigest: digestJson(toolEvidence.snapshots),
      toolOperations: toolEvidence.snapshots.map((snapshot) => ({
        operationId: snapshot.operationId,
        status: snapshot.status,
        ...(snapshot.result === undefined ? {} : { resultDigest: snapshot.result.outputDigest }),
      })),
      evidenceRefs,
    };
    const executionEvidence = this.evidence.put({
      evidenceId: `execution-${request.roleRunId}`,
      version: "1",
      kind: "execution",
      taskId: request.taskId,
      runId: request.runId,
      roleRunId: request.roleRunId,
      producer: { producerId: request.worker.actorId, producerType: "worker" },
      subjectRefs: [this.manifestRef(request.runId, started.manifestDigest)],
      content: toJson(executionContent),
    });
    const allEvidenceRefs = [...evidenceRefs, formatEvidenceRef(executionEvidence)];
    const artifactInput = {
      id: request.executionResultId,
      version: "1",
      kind: "execution_result",
      content: toJson(executionContent),
      digest: digestJson(executionContent),
      createdBy: request.worker.actorId,
    } as const;
    const currentTask = this.controlPlane.getTask(request.taskId);
    const currentRun = this.controlPlane.getRun(request.runId);
    const handoff = this.controlPlane.submitExecutionForVerification({
      commandId: `${request.roleRunId}:submit`,
      actor: request.worker,
      taskId: request.taskId,
      expectedTaskVersion: currentTask.version,
      runId: request.runId,
      expectedRunVersion: currentRun.version,
      roleRunId: request.roleRunId,
      expectedRoleRunVersion: settling.version,
      leaseToken: started.leaseToken,
      executionResult: artifactInput,
      toolOperationRefs: operationIds,
      evidenceRefs: allEvidenceRefs,
    });
    return {
      status: "completed",
      task: handoff.task,
      roleRun: handoff.roleRun,
      executionResult: handoff.executionResult,
      sessionId: started.session.sessionId,
      operationIds,
      evidenceRefs: allEvidenceRefs,
    };
  }

  async verify(request: VerifyRoleRequest): Promise<VerifyRoleOutcome> {
    const task = this.controlPlane.getTask(request.taskId);
    const run = this.controlPlane.getRun(request.runId);
    const manifestRecord = this.controlPlane.getRunManifest(request.runId);
    const rolePlan = this.requireRolePlan(manifestRecord.manifest, request.rolePlanId, "verifier");
    const executorRoleRun = this.controlPlane.getRoleRun(request.executorRoleRunId);
    if (
      executorRoleRun.runId !== request.runId ||
      executorRoleRun.role !== "executor" ||
      executorRoleRun.status !== "settled" ||
      executorRoleRun.outcome !== "succeeded" ||
      executorRoleRun.sessionId === undefined ||
      !executorRoleRun.outputArtifacts.some((ref) => sameRef(ref, request.executionResult))
    ) {
      fail("invalid_configuration", "Verifier request is not bound to the successful Executor RoleRun");
    }
    const collector = new VerificationSubmissionCollector();
    const prepared = this.controlPlane.prepareRoleRun({
      commandId: `${request.roleRunId}:prepare`,
      actor: this.coordinator,
      taskId: request.taskId,
      expectedTaskVersion: task.version,
      runId: request.runId,
      expectedRunVersion: run.version,
      roleRunId: request.roleRunId,
      rolePlanId: request.rolePlanId,
      inputArtifacts: [request.executionResult, manifestRecord.manifest.verification.acceptanceCriteria],
    });
    const totalCheckTimeout = manifestRecord.manifest.verification.requiredChecks.reduce((total, ref) => {
      const definition = this.controlPlane.getArtifact(ref).content as unknown as CheckDefinitionV1;
      return total + (typeof definition.timeoutMs === "number" ? definition.timeoutMs : 0);
    }, 0);
    const leased = this.controlPlane.acquireRoleRunLease({
      commandId: `${request.roleRunId}:lease`,
      actor: request.worker,
      taskId: request.taskId,
      expectedTaskVersion: task.version,
      runId: request.runId,
      expectedRunVersion: run.version,
      roleRunId: request.roleRunId,
      expectedRoleRunVersion: prepared.version,
      leaseOwner: request.worker.actorId,
      leaseDurationMs: this.leaseDuration(request.leaseDurationMs, rolePlan.limits.timeoutMs + totalCheckTimeout),
    });
    const tools = this.verifierTools(rolePlan, collector);
    const started = await this.startRuntime(
      request,
      manifestRecord.manifest,
      manifestRecord.digest,
      rolePlan,
      leased.roleRun,
      tools,
    );
    let checks;
    try {
      checks = await this.assurance.runRequiredChecks({
        taskId: request.taskId,
        runId: request.runId,
        roleRunId: request.roleRunId,
        target: {
          repositoryId: started.manifest.target.repositoryId,
          baseCommit: started.manifest.target.baseCommit,
        },
        requiredChecks: started.manifest.verification.requiredChecks,
        checks: started.manifest.verification.requiredChecks.map((ref) => ({
          ref,
          definition: this.controlPlane.getArtifact(ref).content as unknown as CheckDefinitionV1,
        })),
      });
    } catch {
      started.session.dispose();
      const settling = this.controlPlane.markRoleRunSettling({
        commandId: `${request.roleRunId}:check-setup-failed`,
        actor: request.worker,
        roleRunId: request.roleRunId,
        expectedRoleRunVersion: started.roleRun.version,
        leaseToken: started.leaseToken,
        runtimeOutcome: "incomplete",
        toolOperationRefs: [],
      });
      return this.failRole(request, started.session.sessionId, settling, [], "assurance_check_failed", request.worker);
    }
    const checkPrompt = `${request.prompt}\n\nDeterministic check observations (authoritative):\n${JSON.stringify(
      checks.map((check) => ({
        check: check.observation.check,
        outcome: check.observation.outcome,
        exitCode: check.observation.exitCode ?? null,
        errorCode: check.observation.errorCode ?? null,
        evidenceRef: check.evidenceRef,
      })),
    )}`;
    const runtime = await this.runRuntime(started.session, checkPrompt, rolePlan.limits.timeoutMs);
    const settling = this.controlPlane.markRoleRunSettling({
      commandId: `${request.roleRunId}:runtime-settled`,
      actor: request.worker,
      roleRunId: request.roleRunId,
      expectedRoleRunVersion: started.roleRun.version,
      leaseToken: started.leaseToken,
      runtimeOutcome: runtime.result.outcome,
      toolOperationRefs: [],
    });
    const runtimeEvidence = this.saveRuntimeEvidence(request, started, runtime);
    const evidenceRefs = [formatEvidenceRef(runtimeEvidence), ...checks.map((check) => check.evidenceRef)];
    if (runtime.result.outcome !== "completed") {
      return this.failRole(request, started.session.sessionId, settling, evidenceRefs, runtime.result.outcome, request.worker);
    }
    let submission: VerificationSubmission;
    try {
      submission = collector.requireSingle();
    } catch {
      return this.failRole(request, started.session.sessionId, settling, evidenceRefs, "invalid_verification_submission", request.worker);
    }
    let assured;
    try {
      assured = this.assurance.sealVerification({
        evidenceId: `verification-${request.roleRunId}`,
        taskId: request.taskId,
        runId: request.runId,
        manifestDigest: started.manifestDigest,
        target: {
          repositoryId: started.manifest.target.repositoryId,
          baseCommit: started.manifest.target.baseCommit,
        },
        executionResult: request.executionResult,
        executor: { roleRunId: request.executorRoleRunId, sessionId: executorRoleRun.sessionId },
        verifier: { roleRunId: request.roleRunId, sessionId: started.session.sessionId },
        requiredChecks: started.manifest.verification.requiredChecks,
        checks,
        submission,
      });
    } catch {
      return this.failRole(request, started.session.sessionId, settling, evidenceRefs, "assurance_rejected", request.worker);
    }
    const allEvidenceRefs = [...evidenceRefs, assured.evidenceRef];
    const verificationInput = {
      id: request.verificationResultId,
      version: "1",
      kind: "verification_result",
      content: toJson(assured.content),
      digest: digestJson(assured.content),
      createdBy: request.worker.actorId,
    } as const;
    const currentTask = this.controlPlane.getTask(request.taskId);
    const currentRun = this.controlPlane.getRun(request.runId);
    const verification = this.controlPlane.submitVerificationResult({
      commandId: `${request.roleRunId}:submit`,
      actor: request.worker,
      taskId: request.taskId,
      expectedTaskVersion: currentTask.version,
      runId: request.runId,
      expectedRunVersion: currentRun.version,
      roleRunId: request.roleRunId,
      expectedRoleRunVersion: settling.version,
      leaseToken: started.leaseToken,
      verificationResult: verificationInput,
      executionResult: request.executionResult,
      verdict: submission.verdict,
      ...(submission.findingClass === undefined ? {} : { findingClass: submission.findingClass }),
      reasonCode: submission.verdict === "pass"
        ? "assurance_passed"
        : submission.verdict === "blocked"
          ? "verification_external_blocked"
          : `verification_${submission.findingClass}_failed`,
      evidenceRefs: allEvidenceRefs,
    });
    return {
      status: "completed",
      task: verification.task,
      run: verification.run,
      roleRun: verification.roleRun,
      verificationResult: verification.verificationResult,
      sessionId: started.session.sessionId,
      evidenceRefs: allEvidenceRefs,
    };
  }

  private async startRuntime(
    request: ExecuteRoleRequest | VerifyRoleRequest,
    manifest: RunManifestV1,
    manifestDigest: string,
    rolePlan: RolePlan,
    roleRun: RoleRun,
    tools: readonly RuntimeTool[],
  ): Promise<StartedRole> {
    await this.validateResourceKinds(rolePlan);
    const projection = await this.resources.project(
      [...rolePlan.resources, ...rolePlan.skills, ...rolePlan.prompts],
      rolePlan.role,
    );
    const artifactContext = this.roleArtifactContext(rolePlan.role, manifest, request);
    const runtimeResources: RuntimeResourceSnapshot = {
      systemPrompt: {
        source: `emi-runtime:${rolePlan.role}@1`,
        content: `${rolePlan.role === "executor"
          ? "Execute only the approved plan. Use only provided tools and submit exactly one structured execution result."
          : "Independently verify the bound execution and authoritative checks. Do not modify the target and submit exactly one verdict."}\nRun manifest: ${manifestDigest}. Target repository: ${manifest.target.repositoryId}. Base commit: ${manifest.target.baseCommit}.`,
      },
      appendSystemPrompts: projection.appendSystemPrompts,
      contextFiles: [...projection.contextFiles, ...artifactContext],
    };
    const thinkingLevel = rolePlan.model.thinkingLevel;
    if (thinkingLevel !== undefined && !THINKING_LEVELS.has(thinkingLevel as RuntimeThinkingLevel)) {
      fail("invalid_configuration", `Unsupported Runtime thinking level: ${thinkingLevel}`);
    }
    const session = await this.runtime.startSession({
      runId: request.runId,
      roleRunId: request.roleRunId,
      role: rolePlan.role,
      cwd: request.cwd,
      model: {
        provider: rolePlan.model.provider,
        id: rolePlan.model.modelId,
        ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as RuntimeThinkingLevel }),
      },
      resources: runtimeResources,
      tools,
    });
    if (
      session.runId !== request.runId ||
      session.roleRunId !== request.roleRunId ||
      session.role !== rolePlan.role ||
      !exactStrings(session.activeToolNames, tools.map((tool) => tool.name))
    ) {
      session.dispose();
      fail("invalid_configuration", "Runtime Session does not match the authorized RoleRun contract");
    }
    let running: RoleRun;
    try {
      running = this.controlPlane.markRoleRunRunning({
        commandId: `${request.roleRunId}:session-started`,
        actor: request.worker,
        roleRunId: request.roleRunId,
        expectedRoleRunVersion: roleRun.version,
        leaseToken: roleRun.leaseToken,
        sessionId: session.sessionId,
      });
    } catch (error) {
      session.dispose();
      throw error;
    }
    return { manifest, manifestDigest, rolePlan, roleRun: running, leaseToken: roleRun.leaseToken, session };
  }

  private roleArtifactContext(
    role: RolePlan["role"],
    manifest: RunManifestV1,
    request: ExecuteRoleRequest | VerifyRoleRequest,
  ): RuntimeTextResource[] {
    if (role === "coordinator") {
      fail("invalid_configuration", "Coordinator RolePlans are not executable through this integration path");
    }
    const refs = role === "executor"
      ? [
          { ref: manifest.inputs.trd, kind: "trd" },
          { ref: manifest.inputs.executionPlan, kind: "execution_plan" },
          { ref: manifest.verification.acceptanceCriteria, kind: "acceptance_criteria" },
        ]
      : [
          { ref: (request as VerifyRoleRequest).executionResult, kind: "execution_result" },
          { ref: manifest.verification.acceptanceCriteria, kind: "acceptance_criteria" },
        ];
    return refs.map(({ ref, kind }) => {
      const artifact = this.controlPlane.getArtifact(ref);
      if (artifact.kind !== kind) {
        fail("invalid_configuration", `Expected ${kind} artifact for ${role}, received ${artifact.kind}`);
      }
      return {
        source: `emi-artifact:${artifact.kind}:${artifact.id}@${artifact.version}#${artifact.digest}`,
        content: artifact.canonicalJson,
      };
    });
  }

  private async runRuntime(session: RuntimeSession, prompt: string, timeoutMs: number): Promise<RuntimeObservation> {
    const events: RuntimeEvent[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void session.abort().catch(() => undefined);
    }, timeoutMs);
    let result: RuntimeRunResult;
    try {
      result = await session.run(prompt);
      if (timedOut) result = { outcome: "aborted", errorMessage: "Runtime exceeded RolePlan timeout" };
    } catch {
      result = { outcome: timedOut ? "aborted" : "error", errorMessage: timedOut ? "Runtime exceeded RolePlan timeout" : "Runtime failed" };
    } finally {
      clearTimeout(timer);
      unsubscribe();
      session.dispose();
    }
    return { result, events };
  }

  private saveRuntimeEvidence(
    request: ExecuteRoleRequest | VerifyRoleRequest,
    started: StartedRole,
    runtime: RuntimeObservation,
  ): EvidenceRecord {
    return this.evidence.put({
      evidenceId: `runtime-${request.roleRunId}`,
      version: "1",
      kind: "runtime",
      taskId: request.taskId,
      runId: request.runId,
      roleRunId: request.roleRunId,
      producer: { producerId: "integration.runtime-recorder", producerType: "system" },
      subjectRefs: [this.manifestRef(request.runId, started.manifestDigest)],
      content: toJson({
        schemaVersion: "1",
        role: started.rolePlan.role,
        sessionId: started.session.sessionId,
        outcome: runtime.result.outcome,
        events: runtime.events.map(eventEvidence),
      }),
    });
  }

  private async settleToolEvidence(
    request: ExecuteRoleRequest,
    started: StartedRole,
    operationIds: readonly string[],
  ): Promise<SettledToolEvidence> {
    const snapshots: SettledToolEvidence["snapshots"][number][] = [];
    const evidenceRefs: string[] = [];
    const changedPaths = new Set<string>();
    let unknown = false;
    for (const operationId of operationIds) {
      let operation = this.gateway.getOperation(operationId);
      if (operation.runId !== request.runId || operation.roleRunId !== request.roleRunId) {
        fail("role_failed", `Tool Operation is not bound to current RoleRun: ${operationId}`);
      }
      if (["authorized", "executing", "unknown"].includes(operation.status)) {
        operation = (await this.gateway.reconcile(operationId)).operation;
      }
      const result = this.gateway.getResult(operationId);
      if (["authorized", "executing", "unknown"].includes(operation.status)) unknown = true;
      if (operation.status === "succeeded" && result !== undefined && typeof result.output.path === "string") {
        changedPaths.add(result.output.path);
      }
      const snapshot = { operationId, status: operation.status, ...(result === undefined ? {} : { result }) };
      snapshots.push(snapshot);
      const evidence = this.evidence.put({
        evidenceId: `tool-${digestJson({ runId: request.runId, operationId }).slice(7, 31)}`,
        version: "1",
        kind: "tool_operation",
        taskId: request.taskId,
        runId: request.runId,
        roleRunId: request.roleRunId,
        producer: { producerId: "integration.gateway-snapshot", producerType: "system" },
        subjectRefs: [this.manifestRef(request.runId, started.manifestDigest)],
        content: toJson(snapshot),
      });
      evidenceRefs.push(formatEvidenceRef(evidence));
    }
    return {
      operationIds: [...operationIds],
      evidenceRefs,
      actualChangedPaths: [...changedPaths].sort(),
      unknown,
      snapshots,
    };
  }

  private executorTools(
    rolePlan: RolePlan,
    submission: ExecutionSubmissionCollector,
    gateway: GatewayRuntimeToolCollector,
    context: { runId: string; roleRunId: string; leaseToken: number },
  ): RuntimeTool[] {
    let submissionCount = 0;
    const tools = rolePlan.tools.map((tool) => {
      if (tool.name === WORKSPACE_WRITE_TOOL_REF.name) return gateway.createWorkspaceWriteTool(tool, context);
      if (tool.name === SUBMIT_EXECUTION_TOOL_REF.name) {
        assertToolRef(tool, SUBMIT_EXECUTION_TOOL_REF);
        submissionCount += 1;
        return submission.tool;
      }
      fail("tool_contract_mismatch", `Executor tool is unsupported in v0.1: ${tool.name}`);
    });
    if (submissionCount !== 1) fail("tool_contract_mismatch", "Executor RolePlan requires one submit_execution tool");
    return tools;
  }

  private verifierTools(rolePlan: RolePlan, submission: VerificationSubmissionCollector): RuntimeTool[] {
    let submissionCount = 0;
    const tools = rolePlan.tools.map((tool) => {
      if (tool.name !== SUBMIT_VERIFICATION_TOOL_REF.name) {
        fail("tool_contract_mismatch", `Verifier tool is unsupported in v0.1: ${tool.name}`);
      }
      assertToolRef(tool, SUBMIT_VERIFICATION_TOOL_REF);
      submissionCount += 1;
      return submission.tool;
    });
    if (submissionCount !== 1) fail("tool_contract_mismatch", "Verifier RolePlan requires one submit_verification tool");
    return tools;
  }

  private requireRolePlan(manifest: RunManifestV1, rolePlanId: string, role: "executor" | "verifier"): RolePlan {
    const rolePlan = manifest.roles.find((candidate) => candidate.rolePlanId === rolePlanId);
    if (rolePlan === undefined || rolePlan.role !== role) {
      fail("invalid_configuration", `RunManifest does not contain ${role} RolePlan: ${rolePlanId}`);
    }
    const expectedIsolation = role === "executor" ? LOCAL_WORKSPACE_ISOLATION_REF : VERIFIER_READONLY_ISOLATION_REF;
    if (!sameRef(rolePlan.isolationProfile, expectedIsolation)) {
      fail("invalid_configuration", `${role} RolePlan isolation profile is not supported in v0.1`);
    }
    return rolePlan;
  }

  private async validateResourceKinds(rolePlan: RolePlan): Promise<void> {
    for (const [kind, refs] of [
      ["emi_context", rolePlan.resources],
      ["skill", rolePlan.skills],
      ["prompt", rolePlan.prompts],
    ] as const) {
      for (const ref of refs) {
        const loaded = await this.resources.load(ref, rolePlan.role);
        if (loaded.manifest.kind !== kind) {
          fail("invalid_configuration", `RolePlan ${kind} reference has kind ${loaded.manifest.kind}: ${ref.id}`);
        }
      }
    }
  }

  private leaseDuration(requested: number | undefined, expectedWorkMs: number): number {
    const duration = requested ?? Math.min(86_400_000, Math.max(60_000, expectedWorkMs + 30_000));
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 86_400_000) {
      fail("invalid_configuration", "Role leaseDurationMs must be between 1 and 86400000");
    }
    return duration;
  }

  private failRole(
    request: ExecuteRoleRequest | VerifyRoleRequest,
    sessionId: string,
    roleRun: RoleRun,
    evidenceRefs: readonly string[],
    errorCode: string,
    worker: Actor,
  ): UnsuccessfulRole {
    const outcome = this.controlPlane.settleRoleRun({
      commandId: `${request.roleRunId}:failed:${errorCode}`,
      actor: worker,
      roleRunId: request.roleRunId,
      expectedRoleRunVersion: roleRun.version,
      leaseToken: roleRun.leaseToken,
      outcome: errorCode === "aborted" ? "aborted" : "failed",
      errorCode,
      sanitizedError: "Role did not satisfy the controlled handoff conditions",
      evidenceRefs,
    });
    return {
      status: "failed",
      task: this.controlPlane.getTask(request.taskId),
      run: this.controlPlane.getRun(request.runId),
      roleRun: outcome,
      sessionId,
      evidenceRefs,
      errorCode,
    };
  }

  private blockRole(
    request: ExecuteRoleRequest | VerifyRoleRequest,
    sessionId: string,
    roleRun: RoleRun,
    evidenceRefs: readonly string[],
    errorCode: string,
    worker: Actor,
  ): UnsuccessfulRole {
    const task = this.controlPlane.getTask(request.taskId);
    const run = this.controlPlane.getRun(request.runId);
    const blocked = this.controlPlane.blockRoleRun({
      commandId: `${request.roleRunId}:blocked:${errorCode}`,
      actor: worker,
      taskId: request.taskId,
      expectedTaskVersion: task.version,
      runId: request.runId,
      expectedRunVersion: run.version,
      roleRunId: request.roleRunId,
      expectedRoleRunVersion: roleRun.version,
      leaseToken: roleRun.leaseToken,
      reasonCode: errorCode,
      sanitizedError: "Role has an unresolved external operation",
      evidenceRefs,
    });
    return {
      status: "blocked",
      task: blocked.task,
      run: blocked.run,
      roleRun: blocked.roleRun,
      sessionId,
      evidenceRefs,
      errorCode,
    };
  }

  private manifestRef(runId: string, digest: string): VersionedRef {
    return { id: runId, version: "1", digest };
  }
}
