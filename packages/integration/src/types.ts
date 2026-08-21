import type { Artifact, RoleRun, Run, Task, VersionedRef } from "@emi-harness/control-plane";

export interface ExecutionSubmission {
  summary: string;
  changedPaths: readonly string[];
  selfChecks: readonly string[];
}

export interface VerificationSubmission {
  verdict: "blocked" | "fail" | "pass";
  findingClass?: "context" | "external" | "implementation" | "prd" | "trd";
  reason: string;
  findings: readonly string[];
}

export interface BaseRoleRequest {
  taskId: string;
  runId: string;
  roleRunId: string;
  rolePlanId: string;
  cwd: string;
  prompt: string;
  worker: {
    actorId: string;
    actorType: "worker";
    roles: readonly string[];
  };
  leaseDurationMs?: number;
}

export interface ExecuteRoleRequest extends BaseRoleRequest {
  executionResultId: string;
}

export interface VerifyRoleRequest extends BaseRoleRequest {
  executionResult: VersionedRef;
  executorRoleRunId: string;
  verificationResultId: string;
}

export interface CompletedExecutionRole {
  status: "completed";
  task: Task;
  roleRun: RoleRun;
  executionResult: Artifact;
  sessionId: string;
  operationIds: readonly string[];
  evidenceRefs: readonly string[];
}

export interface CompletedVerificationRole {
  status: "completed";
  task: Task;
  run: Run;
  roleRun: RoleRun;
  verificationResult: Artifact;
  sessionId: string;
  evidenceRefs: readonly string[];
}

export interface UnsuccessfulRole {
  status: "blocked" | "failed";
  task: Task;
  run: Run;
  roleRun: RoleRun;
  sessionId: string;
  evidenceRefs: readonly string[];
  errorCode: string;
}

export type ExecuteRoleOutcome = CompletedExecutionRole | UnsuccessfulRole;
export type VerifyRoleOutcome = CompletedVerificationRole | UnsuccessfulRole;
