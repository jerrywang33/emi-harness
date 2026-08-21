import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { type SqliteEvidenceStore } from "@emi-harness/assurance";
import {
  canonicalizeJson,
  digestJson,
  type JsonObject,
  type JsonValue,
  type SqliteControlPlane,
  type VersionedRef,
} from "@emi-harness/control-plane";
import { sha256Text } from "@emi-harness/resource-registry";
import type { SqliteToolGateway } from "@emi-harness/tool-gateway";

import { fail } from "./errors.js";

export interface CandidateEvidencePackageRequest {
  packageId: string;
  taskId: string;
  runId: string;
  exportedAt: string;
  controlledResources: readonly ControlledResourceSnapshot[];
}

export interface ControlledResourceSnapshot {
  ref: VersionedRef;
  manifest: JsonObject;
  content: string;
}

export interface CandidateEvidencePackageEnvelope {
  schemaVersion: "1";
  digest: string;
  content: JsonObject;
}

export interface CandidateEvidencePackageBuilderConfig {
  controlPlane: SqliteControlPlane;
  toolGateway: SqliteToolGateway;
  evidenceStore: SqliteEvidenceStore;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(canonicalizeJson(value)) as JsonValue;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}\u0000${ref.version}\u0000${ref.digest}`;
}

function uniqueRefs(refs: readonly VersionedRef[]): VersionedRef[] {
  const values = new Map<string, VersionedRef>();
  for (const ref of refs) values.set(refKey(ref), ref);
  return [...values.values()].sort((left, right) => {
    const leftKey = refKey(left);
    const rightKey = refKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class CandidateEvidencePackageBuilder {
  constructor(private readonly config: CandidateEvidencePackageBuilderConfig) {}

  build(request: CandidateEvidencePackageRequest): CandidateEvidencePackageEnvelope {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u.test(request.packageId) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(request.exportedAt) ||
      new Date(request.exportedAt).toISOString() !== request.exportedAt
    ) {
      fail("invalid_configuration", "Candidate Evidence Package requires an ID and ISO export time");
    }
    if (request.controlledResources.length === 0) {
      fail("invalid_configuration", "Candidate Evidence Package requires controlled resource snapshots");
    }
    const task = this.config.controlPlane.getTask(request.taskId);
    const run = this.config.controlPlane.getRun(request.runId);
    const manifestRecord = this.config.controlPlane.getRunManifest(request.runId);
    if (task.status !== "awaiting_acceptance" || run.status !== "active" || run.taskId !== task.taskId) {
      fail("invalid_configuration", "Candidate Evidence Package requires an active Run awaiting user acceptance");
    }
    if (manifestRecord.digest !== run.manifestDigest || manifestRecord.manifest.task.taskId !== task.taskId) {
      fail("invalid_configuration", "RunManifest does not match the candidate Task and Run");
    }

    const roleRuns = this.config.controlPlane.listRoleRuns(run.runId);
    if (
      roleRuns.length < 2 ||
      roleRuns.some((roleRun) => roleRun.status !== "settled") ||
      !roleRuns.some((roleRun) => roleRun.role === "executor" && roleRun.outcome === "succeeded") ||
      !roleRuns.some((roleRun) => roleRun.role === "verifier" && roleRun.outcome === "succeeded")
    ) {
      fail("invalid_configuration", "Candidate Evidence Package requires settled successful Executor and Verifier RoleRuns");
    }

    const approvalIds = [
      ...manifestRecord.manifest.inputs.prerequisiteApprovals.map((ref) => ref.id),
      run.authorizationApprovalId,
    ];
    const approvals = [...new Set(approvalIds)].sort().map((approvalId) => {
      const approval = this.config.controlPlane.getApproval(approvalId);
      const decisions = this.config.controlPlane.listApprovalDecisions(approvalId);
      if (
        approval.taskId !== task.taskId ||
        !["approved", "approved_with_conditions"].includes(approval.status) ||
        decisions.length === 0
      ) {
        fail("invalid_configuration", `Approval is not exportable: ${approvalId}`);
      }
      const prerequisite = manifestRecord.manifest.inputs.prerequisiteApprovals.find((ref) => ref.id === approvalId);
      if (prerequisite !== undefined && refKey(this.config.controlPlane.getApprovalRef(approvalId)) !== refKey(prerequisite)) {
        fail("invalid_configuration", `Approval no longer matches the RunManifest snapshot: ${approvalId}`);
      }
      if (
        approvalId === run.authorizationApprovalId &&
        (approval.gate !== "run_authorization" || approval.status !== "approved" || approval.subject.digest !== run.manifestDigest)
      ) {
        fail("invalid_configuration", `Run Authorization does not match the RunManifest: ${approvalId}`);
      }
      return { approval, decisions };
    });

    const artifactRefs = uniqueRefs([
      manifestRecord.manifest.inputs.prd,
      manifestRecord.manifest.inputs.contextManifest,
      manifestRecord.manifest.inputs.trd,
      manifestRecord.manifest.inputs.executionPlan,
      manifestRecord.manifest.verification.acceptanceCriteria,
      ...manifestRecord.manifest.verification.requiredChecks,
      ...roleRuns.flatMap((roleRun) => [...roleRun.inputArtifacts, ...roleRun.outputArtifacts]),
    ]);
    const artifacts = artifactRefs.map((ref) => this.config.controlPlane.getArtifact(ref));

    const roleRunIds = new Set(roleRuns.map((roleRun) => roleRun.roleRunId));
    const operationIds = [...new Set(roleRuns.flatMap((roleRun) => roleRun.toolOperationRefs))].sort();
    const ledgerOperationIds = roleRuns
      .flatMap((roleRun) => this.config.toolGateway.listOperationsForRoleRun(roleRun.roleRunId))
      .map((operation) => operation.operationId)
      .sort();
    if (
      operationIds.length !== ledgerOperationIds.length ||
      operationIds.some((operationId, index) => operationId !== ledgerOperationIds[index])
    ) {
      fail("invalid_configuration", "RoleRun Tool Operation refs do not cover the complete Gateway ledger");
    }
    const toolOperations = operationIds.map((operationId) => {
      const operation = this.config.toolGateway.getOperation(operationId);
      const decision = this.config.toolGateway.getDecision(operationId);
      const result = this.config.toolGateway.getResult(operationId);
      if (
        operation.runId !== run.runId ||
        !roleRunIds.has(operation.roleRunId) ||
        !["denied", "failed", "succeeded"].includes(operation.status) ||
        (["failed", "succeeded"].includes(operation.status) && result === undefined)
      ) {
        fail("invalid_configuration", `Tool Operation is not settled for export: ${operationId}`);
      }
      return {
        operation,
        decision,
        ...(decision.outcome === "allow" ? { intent: this.config.toolGateway.getIntent(operationId) } : {}),
        ...(result === undefined ? {} : { result }),
        transitions: this.config.toolGateway.listTransitions(operationId),
      };
    });

    const evidence = this.config.evidenceStore.listForRun(run.runId);
    if (evidence.length === 0) fail("invalid_configuration", "Candidate Evidence Package has no Evidence");
    for (const record of evidence) {
      if (record.taskId !== task.taskId || record.runId !== run.runId) {
        fail("invalid_configuration", `Evidence is bound to another Task or Run: ${record.evidenceId}`);
      }
      this.config.evidenceStore.get({ id: record.evidenceId, version: record.version, digest: record.digest });
    }
    const evidenceKinds = new Set(evidence.map((record) => record.kind));
    const missingKinds = manifestRecord.manifest.verification.requiredEvidence.filter((kind) => !evidenceKinds.has(
      kind as typeof evidence[number]["kind"],
    ));
    if (missingKinds.length > 0) {
      fail("invalid_configuration", `Candidate Evidence Package lacks required Evidence: ${missingKinds.join(", ")}`);
    }

    const expectedResourceRefs = uniqueRefs(manifestRecord.manifest.roles.flatMap((role) => [
      ...role.resources,
      ...role.skills,
      ...role.prompts,
    ]));
    const actualResourceRefs = uniqueRefs(request.controlledResources.map((resource) => resource.ref));
    if (
      expectedResourceRefs.length !== actualResourceRefs.length ||
      expectedResourceRefs.some((ref, index) => refKey(ref) !== refKey(actualResourceRefs[index]!))
    ) {
      fail("invalid_configuration", "Controlled resource snapshots do not match the RunManifest");
    }
    for (const resource of request.controlledResources) {
      const contentDescriptor = resource.manifest.content;
      if (
        resource.manifest.resourceId !== resource.ref.id ||
        resource.manifest.version !== resource.ref.version ||
        !isObject(contentDescriptor) ||
        typeof contentDescriptor.digest !== "string" ||
        sha256Text(resource.content) !== contentDescriptor.digest
      ) {
        fail("invalid_configuration", `Controlled resource snapshot is invalid: ${resource.ref.id}`);
      }
    }

    const content = toJson({
      schemaVersion: "1",
      packageId: request.packageId,
      packageType: "candidate_delivery",
      exportedAt: request.exportedAt,
      acceptance: {
        status: "pending",
        userDecisionRecorded: false,
        taskStatus: task.status,
      },
      task,
      taskTransitions: this.config.controlPlane.listTaskTransitions(task.taskId),
      run,
      runTransitions: this.config.controlPlane.listRunTransitions(run.runId),
      manifest: {
        digest: manifestRecord.digest,
        content: manifestRecord.manifest,
      },
      approvals,
      artifacts,
      roleRuns: roleRuns.map((roleRun) => ({
        record: roleRun,
        transitions: this.config.controlPlane.listRoleRunTransitions(roleRun.roleRunId),
      })),
      toolOperations,
      controlledResources: request.controlledResources,
      evidence,
    }) as JsonObject;
    return { schemaVersion: "1", digest: digestJson(content), content };
  }
}

export function serializeCandidateEvidencePackage(envelope: CandidateEvidencePackageEnvelope): string {
  verifyCandidateEvidencePackage(envelope);
  return `${canonicalizeJson(envelope)}\n`;
}

export function parseCandidateEvidencePackage(serialized: string): CandidateEvidencePackageEnvelope {
  const parsed = JSON.parse(serialized) as unknown;
  if (!isObject(parsed) || parsed.schemaVersion !== "1" || typeof parsed.digest !== "string" || !isObject(parsed.content)) {
    fail("invalid_configuration", "Candidate Evidence Package envelope is invalid");
  }
  const envelope = parsed as unknown as CandidateEvidencePackageEnvelope;
  verifyCandidateEvidencePackage(envelope);
  return envelope;
}

export function verifyCandidateEvidencePackage(envelope: CandidateEvidencePackageEnvelope): void {
  if (
    envelope.schemaVersion !== "1" ||
    !/^sha256:[0-9a-f]{64}$/u.test(envelope.digest) ||
    digestJson(envelope.content) !== envelope.digest ||
    envelope.content.schemaVersion !== "1" ||
    envelope.content.packageType !== "candidate_delivery" ||
    !isObject(envelope.content.acceptance) ||
    envelope.content.acceptance.status !== "pending" ||
    envelope.content.acceptance.userDecisionRecorded !== false
  ) {
    fail("invalid_configuration", "Candidate Evidence Package digest or acceptance boundary is invalid");
  }
}

export async function writeCandidateEvidencePackage(input: {
  targetRoot: string;
  relativePath: string;
  envelope: CandidateEvidencePackageEnvelope;
}): Promise<void> {
  if (!/^\.emi-harness\/evidence\/[A-Za-z0-9_.-]+\.candidate\.json$/u.test(input.relativePath)) {
    fail("invalid_configuration", "Candidate Evidence Package path must be under .emi-harness/evidence");
  }
  const root = await realpath(input.targetRoot);
  const destination = resolve(root, input.relativePath);
  if (!destination.startsWith(`${root}${sep}`)) fail("invalid_configuration", "Evidence Package path escapes target root");
  const directory = resolve(root, ".emi-harness/evidence");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || await realpath(directory) !== directory) {
    fail("invalid_configuration", "Evidence Package directory is not a real target directory");
  }
  const temporary = resolve(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serializeCandidateEvidencePackage(input.envelope), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
