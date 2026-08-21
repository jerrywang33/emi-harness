import type {
  Actor,
  ApprovalCondition,
  ApprovalDecisionValue,
  ArtifactInput,
  PendingRunOutcome,
  RoleRunOutcome,
  RunManifestV1,
  RuntimeOutcome,
  TaskStatus,
  VerificationFindingClass,
  VerificationVerdict,
  VersionedRef,
} from "./types.js";

export interface CommandRequest {
  commandId: string;
  actor: Actor;
}

export interface RegisterArtifactCommand extends CommandRequest {
  artifact: ArtifactInput;
}

export interface CreateTaskCommand extends CommandRequest {
  taskId: string;
  goal: string;
  prd: VersionedRef;
}

export interface StartContextualizationCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  reason: string;
}

export interface CompleteContextualizationCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  contextManifest: VersionedRef;
  evidenceRefs: readonly string[];
}

export interface SubmitTrdForApprovalCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  trd: VersionedRef;
  approvalId: string;
  policyVersion: string;
  requiredRoles: readonly string[];
  expiresAt?: string;
}

export interface RecordApprovalDecisionCommand extends CommandRequest {
  approvalId: string;
  expectedApprovalVersion: number;
  expectedTaskVersion: number;
  expectedRunVersion?: number;
  decisionId: string;
  authorityRole: string;
  decision: ApprovalDecisionValue;
  reason: string;
  conditions: readonly ApprovalCondition[];
  evidenceRefs: readonly string[];
  returnToStatus?: "intake" | "contextualizing" | "drafting_trd";
}

export interface SealRunManifestCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  runId: string;
  manifest: RunManifestV1;
  authorizationApprovalId: string;
  authorizationPolicyVersion: string;
  requiredAuthorizationRoles: readonly string[];
  authorizationExpiresAt?: string;
}

export interface PrepareRoleRunCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  runId: string;
  expectedRunVersion: number;
  roleRunId: string;
  rolePlanId: string;
  inputArtifacts: readonly VersionedRef[];
}

export interface AcquireRoleRunLeaseCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  runId: string;
  expectedRunVersion: number;
  roleRunId: string;
  expectedRoleRunVersion: number;
  leaseOwner: string;
  leaseDurationMs: number;
}

export interface MarkRoleRunRunningCommand extends CommandRequest {
  roleRunId: string;
  expectedRoleRunVersion: number;
  leaseToken: number;
  sessionId: string;
}

export interface MarkRoleRunSettlingCommand extends CommandRequest {
  roleRunId: string;
  expectedRoleRunVersion: number;
  leaseToken: number;
  runtimeOutcome: RuntimeOutcome;
  toolOperationRefs: readonly string[];
}

export interface SettleRoleRunCommand extends CommandRequest {
  roleRunId: string;
  expectedRoleRunVersion: number;
  leaseToken: number;
  outcome: Exclude<RoleRunOutcome, "succeeded">;
  errorCode: string;
  sanitizedError: string;
  evidenceRefs: readonly string[];
}

export interface BlockRoleRunCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  runId: string;
  expectedRunVersion: number;
  roleRunId: string;
  expectedRoleRunVersion: number;
  leaseToken: number;
  reasonCode: string;
  sanitizedError: string;
  evidenceRefs: readonly string[];
}

export interface SubmitExecutionForVerificationCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  runId: string;
  expectedRunVersion: number;
  roleRunId: string;
  expectedRoleRunVersion: number;
  leaseToken: number;
  executionResult: ArtifactInput;
  toolOperationRefs: readonly string[];
  evidenceRefs: readonly string[];
}

export interface SubmitVerificationResultCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  runId: string;
  expectedRunVersion: number;
  roleRunId: string;
  expectedRoleRunVersion: number;
  leaseToken: number;
  verificationResult: ArtifactInput;
  executionResult: VersionedRef;
  verdict: VerificationVerdict;
  findingClass?: VerificationFindingClass;
  reasonCode: string;
  evidenceRefs: readonly string[];
}

export interface RequestAcceptanceReworkCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  runId: string;
  expectedRunVersion: number;
  acceptanceFeedback: ArtifactInput;
  executionResult: VersionedRef;
  verificationResult: VersionedRef;
  findingClass?: Exclude<VerificationFindingClass, "external">;
  reasonCode: string;
}

export interface AcceptDeliveryCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  runId: string;
  expectedRunVersion: number;
  executionResult: VersionedRef;
  verificationResult: VersionedRef;
  evidenceRefs: readonly string[];
  reason: string;
}

export interface CancelTaskCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  expectedRunVersion?: number;
  reasonCode: string;
  evidenceRefs: readonly string[];
}

export interface FinishRunStopCommand extends CommandRequest {
  taskId: string;
  expectedTaskVersion: number;
  runId: string;
  expectedRunVersion: number;
  outcome: PendingRunOutcome;
  evidenceRefs: readonly string[];
  upstreamStatus?: "intake" | "contextualizing" | "drafting_trd" | "planning";
}

export interface InvalidateApprovalCommand extends CommandRequest {
  approvalId: string;
  expectedApprovalVersion: number;
  expectedTaskVersion: number;
  expectedRunVersion?: number;
  action: "withdrawn" | "expired" | "revoked";
  reasonCode: string;
  evidenceRefs: readonly string[];
}

export interface MarkOutboxDeliveredCommand extends CommandRequest {
  eventId: string;
}
