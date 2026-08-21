import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  AssuranceService,
  NodeCheckRunner,
  SqliteEvidenceStore,
  type CheckDefinitionV1,
} from "@emi-harness/assurance";
import {
  digestJson,
  SqliteControlPlane,
  type Actor,
  type ArtifactInput,
  type Clock,
  type IdGenerator,
  type RunManifestV1,
  type VersionedRef,
} from "@emi-harness/control-plane";
import { FileResourceRegistry } from "@emi-harness/resource-registry";
import type { PiRuntimePort, RuntimeAgentOutcome, RuntimeModelRef } from "@emi-harness/runtime-pi";
import {
  ControlPlaneRoleRunAuthority,
  LOCAL_WORKSPACE_ISOLATION_REF,
  SqliteToolGateway,
  SubprocessWorkspaceExecutor,
  WORKSPACE_WRITE_POLICY_REF,
  WORKSPACE_WRITE_TOOL,
  WORKSPACE_WRITE_TOOL_REF,
  WorkspaceWritePolicy,
  type IsolatedToolExecutorPort,
} from "@emi-harness/tool-gateway";

import {
  INTERNAL_SUBMISSION_POLICY_REF,
  RoleExecutionCoordinator,
  SUBMIT_EXECUTION_TOOL_REF,
  SUBMIT_VERIFICATION_TOOL_REF,
  VERIFIER_READONLY_ISOLATION_REF,
} from "../src/index.js";
import { ScriptedRuntime, type ScriptedToolCall } from "./scripted-runtime.js";

export class TestClock implements Clock {
  now(): string {
    return "2026-08-21T00:00:00.000Z";
  }
}

export class TestIds implements IdGenerator {
  private value = 0;

  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${String(this.value).padStart(4, "0")}`;
  }
}

export const coordinator: Actor = { actorId: "agent-coordinator", actorType: "agent", roles: ["coordinator"] };
export const architect: Actor = { actorId: "human-architect", actorType: "human", roles: ["architecture_authority"] };
export const delivery: Actor = { actorId: "human-delivery", actorType: "human", roles: ["delivery_authority"] };
export const executorWorker: Actor & { actorType: "worker" } = {
  actorId: "worker-executor",
  actorType: "worker",
  roles: ["executor_worker"],
};
export const verifierWorker: Actor & { actorType: "worker" } = {
  actorId: "worker-verifier",
  actorType: "worker",
  roles: ["verifier_worker"],
};

function artifact(id: string, kind: string, content: ArtifactInput["content"]): ArtifactInput {
  return { id, version: "1", kind, content, digest: digestJson(content), createdBy: coordinator.actorId };
}

function ref(value: ArtifactInput): VersionedRef {
  return { id: value.id, version: value.version, digest: value.digest };
}

export interface HarnessFixture<Runtime extends PiRuntimePort = ScriptedRuntime> {
  root: string;
  stateRoot: string;
  statePaths: {
    controlPlane: string;
    evidence: string;
    toolGateway: string;
  };
  controlPlane: SqliteControlPlane;
  gateway: SqliteToolGateway;
  evidence: SqliteEvidenceStore;
  resourceRegistry: FileResourceRegistry;
  runtime: Runtime;
  coordinator: RoleExecutionCoordinator;
  manifest: RunManifestV1;
  manifestDigest: string;
  closeStores(): void;
  removeRoot(): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessFixtureOptions<Runtime extends PiRuntimePort = ScriptedRuntime> {
  checkPasses?: boolean;
  executor?: IsolatedToolExecutorPort;
  executorCalls?: readonly ScriptedToolCall[];
  executorOutcome?: RuntimeAgentOutcome;
  harnessCommit?: string;
  model?: RuntimeModelRef;
  piPackages?: readonly VersionedRef[];
  prepareTarget?(root: string): Promise<string>;
  repositoryId?: string;
  runtimeAdapter?: VersionedRef;
  runtimeEnvironment?: VersionedRef;
  runtime?: Runtime;
  targetRoot?: string;
  verifierCalls?: readonly ScriptedToolCall[];
}

export async function createHarnessFixture<Runtime extends PiRuntimePort = ScriptedRuntime>(
  options: HarnessFixtureOptions<Runtime> = {},
): Promise<HarnessFixture<Runtime>> {
  if (options.targetRoot !== undefined && !isAbsolute(options.targetRoot)) {
    throw new Error("Harness fixture targetRoot must be absolute");
  }
  const ownsTarget = options.targetRoot === undefined;
  const root = options.targetRoot ?? await mkdtemp(join(tmpdir(), "emi-integration-"));
  if (!ownsTarget) await mkdir(root);
  const stateRoot = await mkdtemp(join(tmpdir(), "emi-integration-state-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "checks"));
  await writeFile(join(root, "AGENTS.md"), "AMBIENT_RESOURCE_MUST_NOT_LOAD\n", "utf8");
  await writeFile(
    join(root, "checks/verify.mjs"),
    options.checkPasses === false
      ? "process.stderr.write('implementation check failed\\n'); process.exit(1);\n"
      : "import { readFile } from 'node:fs/promises'; const text = await readFile(new URL('../src/status.ts', import.meta.url), 'utf8'); if (!text.includes('safeguarded')) process.exit(1); process.stdout.write('verified\\n');\n",
    "utf8",
  );
  const baseCommit = options.prepareTarget === undefined
    ? "0123456789abcdef0123456789abcdef01234567"
    : await options.prepareTarget(root);
  const clock = new TestClock();
  const repositoryId = options.repositoryId ?? "local-target";
  const statePaths = {
    controlPlane: join(stateRoot, "control-plane.sqlite"),
    evidence: join(stateRoot, "evidence.sqlite"),
    toolGateway: join(stateRoot, "tool-gateway.sqlite"),
  };
  const controlPlane = new SqliteControlPlane({
    databasePath: statePaths.controlPlane,
    clock,
    idGenerator: new TestIds(),
  });
  const registry = await FileResourceRegistry.openBundled();
  const contextRef = registry.resolveRef("emi.safeguarding.payment-funds", "2026.08.21");
  const checkDefinition: CheckDefinitionV1 = {
    schemaVersion: "1",
    runner: "node_script",
    scriptPath: "checks/verify.mjs",
    args: [],
    timeoutMs: 5_000,
    expectedExitCode: 0,
  };
  const prerequisites = {
    prd: artifact("prd-1", "prd", { goal: "Add safeguarded status", path: "src/status.ts" }),
    context: artifact("context-manifest-1", "context_manifest", {
      resources: [{ ...contextRef }],
      confirmations: ["TC-001"],
    }),
    trd: artifact("trd-1", "trd", { behavior: "Expose a safeguarded status", controls: ["SG-001", "ED-001"] }),
    plan: artifact("execution-plan-1", "execution_plan", { steps: ["write", "verify"] }),
    criteria: artifact("acceptance-criteria-1", "acceptance_criteria", { criteria: ["status is safeguarded"] }),
    check: artifact("check-1", "check_definition", checkDefinition as unknown as ArtifactInput["content"]),
  };
  let artifactNumber = 0;
  for (const value of Object.values(prerequisites)) {
    artifactNumber += 1;
    controlPlane.registerArtifact({ commandId: `artifact-${artifactNumber}`, actor: coordinator, artifact: value });
  }
  controlPlane.createTask({ commandId: "task:create", actor: coordinator, taskId: "task-1", goal: "Add safeguarded status", prd: ref(prerequisites.prd) });
  controlPlane.startContextualization({
    commandId: "task:context:start",
    actor: coordinator,
    taskId: "task-1",
    expectedTaskVersion: 1,
    reason: "PRD is ready",
  });
  controlPlane.completeContextualization({
    commandId: "task:context:complete",
    actor: coordinator,
    taskId: "task-1",
    expectedTaskVersion: 2,
    contextManifest: ref(prerequisites.context),
    evidenceRefs: ["human-context-confirmation"],
  });
  controlPlane.submitTrdForApproval({
    commandId: "task:trd:submit",
    actor: coordinator,
    taskId: "task-1",
    expectedTaskVersion: 3,
    trd: ref(prerequisites.trd),
    approvalId: "approval-trd-1",
    policyVersion: "1",
    requiredRoles: ["architecture_authority"],
  });
  controlPlane.recordApprovalDecision({
    commandId: "task:trd:approve",
    actor: architect,
    approvalId: "approval-trd-1",
    expectedApprovalVersion: 1,
    expectedTaskVersion: 4,
    decisionId: "decision-trd-1",
    authorityRole: "architecture_authority",
    decision: "approved",
    reason: "TRD is approved",
    conditions: [],
    evidenceRefs: ["architecture-review"],
  });
  const approvalRef = controlPlane.getApprovalRef("approval-trd-1");
  const constantRef = (id: string): VersionedRef => ({ id, version: "1", digest: digestJson({ id }) });
  const manifest: RunManifestV1 = {
    schemaVersion: "1",
    runId: "run-1",
    composedAt: clock.now(),
    composedBy: coordinator.actorId,
    task: { taskId: "task-1", taskRevision: 5 },
    inputs: {
      prd: ref(prerequisites.prd),
      contextManifest: ref(prerequisites.context),
      trd: ref(prerequisites.trd),
      executionPlan: ref(prerequisites.plan),
      prerequisiteApprovals: [approvalRef],
    },
    target: {
      repositoryId,
      baseCommit,
      allowedPaths: ["src/status.ts"],
    },
    runtime: {
      harnessCommit: options.harnessCommit ?? "fedcba9876543210fedcba9876543210fedcba98",
      adapter: options.runtimeAdapter ?? constantRef("runtime-pi-adapter"),
      piPackages: options.piPackages ?? [constantRef("pi-agent-core"), constantRef("pi-coding-agent")],
      environment: options.runtimeEnvironment ?? constantRef("node-24"),
    },
    roles: [
      {
        rolePlanId: "executor-plan",
        role: "executor",
        model: {
          provider: options.model?.provider ?? "scripted",
          modelId: options.model?.id ?? "v0.1",
          ...(options.model?.thinkingLevel === undefined ? {} : { thinkingLevel: options.model.thinkingLevel }),
        },
        resources: [contextRef],
        skills: [],
        prompts: [],
        tools: [WORKSPACE_WRITE_TOOL_REF, SUBMIT_EXECUTION_TOOL_REF],
        isolationProfile: LOCAL_WORKSPACE_ISOLATION_REF,
        credentialBindings: [],
        limits: { maxAttempts: 2, timeoutMs: 10_000 },
      },
      {
        rolePlanId: "verifier-plan",
        role: "verifier",
        model: {
          provider: options.model?.provider ?? "scripted",
          modelId: options.model?.id ?? "v0.1",
          ...(options.model?.thinkingLevel === undefined ? {} : { thinkingLevel: options.model.thinkingLevel }),
        },
        resources: [contextRef],
        skills: [],
        prompts: [],
        tools: [SUBMIT_VERIFICATION_TOOL_REF],
        isolationProfile: VERIFIER_READONLY_ISOLATION_REF,
        credentialBindings: [],
        limits: { maxAttempts: 2, timeoutMs: 10_000 },
      },
    ],
    policies: {
      policyRefs: [WORKSPACE_WRITE_POLICY_REF, INTERNAL_SUBMISSION_POLICY_REF],
      approvalConditions: [],
      maxRoleRuns: 4,
      maxDurationMs: 300_000,
    },
    verification: {
      acceptanceCriteria: ref(prerequisites.criteria),
      requiredChecks: [ref(prerequisites.check)],
      requiredEvidence: ["runtime", "tool_operation", "check_result", "verification_assurance"],
    },
  };
  const sealed = controlPlane.sealRunManifest({
    commandId: "run:seal",
    actor: coordinator,
    taskId: "task-1",
    expectedTaskVersion: 5,
    runId: "run-1",
    manifest,
    authorizationApprovalId: "approval-run-1",
    authorizationPolicyVersion: "1",
    requiredAuthorizationRoles: ["delivery_authority"],
  });
  controlPlane.recordApprovalDecision({
    commandId: "run:approve",
    actor: delivery,
    approvalId: "approval-run-1",
    expectedApprovalVersion: 1,
    expectedTaskVersion: 5,
    expectedRunVersion: 1,
    decisionId: "decision-run-1",
    authorityRole: "delivery_authority",
    decision: "approved",
    reason: "Run scope and permissions are approved",
    conditions: [],
    evidenceRefs: ["run-authorization-review"],
  });

  const isolatedExecutor = options.executor ?? await SubprocessWorkspaceExecutor.create({
    repositoryId,
    workspaceRoot: root,
  });
  const gateway = new SqliteToolGateway({
    databasePath: statePaths.toolGateway,
    authority: new ControlPlaneRoleRunAuthority(controlPlane, clock),
    executor: isolatedExecutor,
    registrations: [{ definition: WORKSPACE_WRITE_TOOL, policy: new WorkspaceWritePolicy() }],
    clock,
    idGenerator: new TestIds(),
  });
  const evidence = new SqliteEvidenceStore({ databasePath: statePaths.evidence, clock });
  const checkRunner = await NodeCheckRunner.create({ repositoryId, workspaceRoot: root, clock });
  const assurance = new AssuranceService(evidence, checkRunner);
  const runtime: PiRuntimePort = options.runtime ?? new ScriptedRuntime();
  if (runtime instanceof ScriptedRuntime) {
    runtime.setScript("role-executor-1", options.executorCalls ?? [
      {
        callId: "write-status",
        name: WORKSPACE_WRITE_TOOL_REF.name,
        input: { path: "src/status.ts", content: "export const status = 'safeguarded';\n", expectedDigest: "absent" },
      },
      {
        callId: "submit-execution",
        name: SUBMIT_EXECUTION_TOOL_REF.name,
        input: { summary: "Added safeguarded status", changedPaths: ["src/status.ts"], selfChecks: ["reviewed output"] },
      },
    ]);
    if (options.executorOutcome !== undefined) runtime.setOutcome("role-executor-1", options.executorOutcome);
    runtime.setScript("role-verifier-1", options.verifierCalls ?? [
      {
        callId: "submit-verification",
        name: SUBMIT_VERIFICATION_TOOL_REF.name,
        input: { verdict: "pass", reason: "Required check passed", findings: [] },
      },
    ]);
  }
  const roleCoordinator = new RoleExecutionCoordinator({
    controlPlane,
    runtime,
    resourceRegistry: registry,
    toolGateway: gateway,
    assurance,
    evidenceStore: evidence,
    coordinator,
  });
  let storesClosed = false;
  const closeStores = () => {
    if (storesClosed) return;
    storesClosed = true;
    gateway.close();
    evidence.close();
    controlPlane.close();
  };
  const removeRoot = async () => {
    await Promise.all([
      ...(ownsTarget ? [rm(root, { recursive: true, force: true })] : []),
      rm(stateRoot, { recursive: true, force: true }),
    ]);
  };
  return {
    root,
    stateRoot,
    statePaths,
    controlPlane,
    gateway,
    evidence,
    resourceRegistry: registry,
    runtime: runtime as Runtime,
    coordinator: roleCoordinator,
    manifest,
    manifestDigest: sealed.manifestDigest,
    closeStores,
    removeRoot,
    close: async () => {
      closeStores();
      await removeRoot();
    },
  };
}
