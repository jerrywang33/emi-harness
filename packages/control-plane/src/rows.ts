import { digestJson } from "@emi-harness/canonical-json";

import { fail } from "./errors.js";
import type {
  Actor,
  Approval,
  ApprovalDecision,
  ApprovalStatus,
  Artifact,
  JsonValue,
  RoleRun,
  RoleRunStatus,
  Run,
  Task,
  TaskStatus,
  VersionedRef,
} from "./types.js";

export interface SqlRow {
  [key: string]: null | number | bigint | string | Uint8Array;
}

export function requireText(label: string, value: string): void {
  if (value.trim().length === 0) {
    fail("invalid_input", `${label} must not be empty`);
  }
}

export function requirePositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("invalid_input", `${label} must be a positive integer`);
  }
}

export function asText(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected text column: ${key}`);
  }
  return value;
}

export function asNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Expected numeric column: ${key}`);
  }
  return value;
}

export function optionalText(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : asText(row, key);
}

export function optionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : asNumber(row, key);
}

/** Spreads `{ [key]: value }` only when value is defined, as required by exactOptionalPropertyTypes. */
export function optionalField<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function uniqueSorted(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => {
    requireText(label, value);
    return value;
  });
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) {
    fail("invalid_input", `${label} must not contain duplicates`);
  }
  return unique;
}

export function validateActor(actor: Actor): void {
  requireText("actorId", actor.actorId);
  uniqueSorted(actor.roles, "actor role");
}

export function approvalRef(approval: Approval): VersionedRef {
  return { id: approval.approvalId, version: String(approval.version), digest: digestJson(approval) };
}

function refFromColumns(row: SqlRow, prefix: string): VersionedRef | undefined {
  const id = optionalText(row, `${prefix}_id`);
  if (id === undefined) {
    return undefined;
  }
  return {
    id,
    version: asText(row, `${prefix}_version`),
    digest: asText(row, `${prefix}_digest`),
  };
}

export function taskFromRow(row: SqlRow): Task {
  const blockedReason = optionalText(row, "blocked_reason");
  return {
    taskId: asText(row, "task_id"),
    version: asNumber(row, "version"),
    status: asText(row, "status") as Task["status"],
    goal: asText(row, "goal"),
    prd: refFromColumns(row, "prd")!,
    ...optionalField("contextManifest", refFromColumns(row, "context")),
    ...optionalField("trd", refFromColumns(row, "trd")),
    ...optionalField("outcome", optionalText(row, "outcome") as Task["outcome"]),
    ...(blockedReason === undefined
      ? {}
      : { blockedReason, resumeToStatus: optionalText(row, "resume_to_status") as TaskStatus }),
    createdAt: asText(row, "created_at"),
    updatedAt: asText(row, "updated_at"),
    ...optionalField("closedAt", optionalText(row, "closed_at")),
  };
}

export function approvalFromRow(row: SqlRow): Approval {
  return {
    approvalId: asText(row, "approval_id"),
    taskId: asText(row, "task_id"),
    version: asNumber(row, "version"),
    gate: asText(row, "gate_type") as Approval["gate"],
    subjectType: asText(row, "subject_type"),
    subject: {
      id: asText(row, "subject_id"),
      version: asText(row, "subject_version"),
      digest: asText(row, "subject_digest"),
    },
    policyVersion: asText(row, "policy_version"),
    requiredRoles: parseJson<string[]>(asText(row, "required_roles_json")),
    requestedBy: asText(row, "requested_by"),
    status: asText(row, "status") as ApprovalStatus,
    ...optionalField("expiresAt", optionalText(row, "expires_at")),
    createdAt: asText(row, "created_at"),
    updatedAt: asText(row, "updated_at"),
  };
}

export function approvalDecisionFromRow(row: SqlRow): ApprovalDecision {
  return {
    decisionId: asText(row, "decision_id"),
    approvalId: asText(row, "approval_id"),
    approvalVersion: asNumber(row, "approval_version"),
    decision: asText(row, "decision") as ApprovalDecision["decision"],
    authorityId: asText(row, "authority_id"),
    authorityRole: asText(row, "authority_role"),
    reason: asText(row, "reason"),
    conditions: parseJson<ApprovalDecision["conditions"]>(asText(row, "conditions_json")),
    evidenceRefs: parseJson<string[]>(asText(row, "evidence_refs_json")),
    decidedAt: asText(row, "decided_at"),
  };
}

export function runFromRow(row: SqlRow): Run {
  return {
    runId: asText(row, "run_id"),
    taskId: asText(row, "task_id"),
    version: asNumber(row, "version"),
    manifestDigest: asText(row, "manifest_digest"),
    authorizationApprovalId: asText(row, "authorization_approval_id"),
    status: asText(row, "status") as Run["status"],
    ...optionalField("outcome", optionalText(row, "outcome") as Run["outcome"]),
    ...optionalField("pendingOutcome", optionalText(row, "pending_outcome") as Run["pendingOutcome"]),
    ...optionalField("resumeToStatus", optionalText(row, "resume_to_status") as Run["resumeToStatus"]),
    ...optionalField("reasonCode", optionalText(row, "reason_code")),
    createdAt: asText(row, "created_at"),
    updatedAt: asText(row, "updated_at"),
    ...optionalField("settledAt", optionalText(row, "settled_at")),
  };
}

export function roleRunFromRow(row: SqlRow): RoleRun {
  return {
    roleRunId: asText(row, "role_run_id"),
    runId: asText(row, "run_id"),
    rolePlanId: asText(row, "role_plan_id"),
    role: asText(row, "role") as RoleRun["role"],
    attempt: asNumber(row, "attempt"),
    version: asNumber(row, "version"),
    status: asText(row, "status") as RoleRunStatus,
    ...optionalField("outcome", optionalText(row, "outcome") as RoleRun["outcome"]),
    ...optionalField("runtimeOutcome", optionalText(row, "runtime_outcome") as RoleRun["runtimeOutcome"]),
    ...optionalField("sessionId", optionalText(row, "session_id")),
    inputArtifacts: parseJson<VersionedRef[]>(asText(row, "input_artifacts_json")),
    outputArtifacts: parseJson<VersionedRef[]>(asText(row, "output_artifacts_json")),
    toolOperationRefs: parseJson<string[]>(asText(row, "tool_operation_refs_json")),
    evidenceRefs: parseJson<string[]>(asText(row, "evidence_refs_json")),
    ...optionalField("leaseOwner", optionalText(row, "lease_owner")),
    ...optionalField("leaseExpiresAt", optionalText(row, "lease_expires_at")),
    leaseToken: asNumber(row, "lease_token"),
    preparedAt: asText(row, "prepared_at"),
    ...optionalField("startedAt", optionalText(row, "started_at")),
    ...optionalField("runtimeEndedAt", optionalText(row, "runtime_ended_at")),
    ...optionalField("settledAt", optionalText(row, "settled_at")),
    ...optionalField("errorCode", optionalText(row, "error_code")),
    ...optionalField("sanitizedError", optionalText(row, "sanitized_error")),
  };
}

export function artifactFromRow(row: SqlRow): Artifact {
  const canonicalJson = asText(row, "canonical_json");
  return {
    id: asText(row, "artifact_id"),
    version: asText(row, "artifact_version"),
    kind: asText(row, "kind"),
    digest: asText(row, "digest"),
    content: parseJson<JsonValue>(canonicalJson),
    canonicalJson,
    createdBy: asText(row, "created_by"),
    createdAt: asText(row, "created_at"),
  };
}
