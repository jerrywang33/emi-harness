export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export type ActorType = "agent" | "human" | "system" | "worker";

export interface Actor {
  actorId: string;
  actorType: ActorType;
  roles: readonly string[];
}

export interface VersionedRef {
  id: string;
  version: string;
  digest: string;
}

export interface ArtifactInput extends VersionedRef {
  kind: string;
  content: JsonValue;
  createdBy: string;
}

export interface Artifact extends VersionedRef {
  kind: string;
  content: JsonValue;
  canonicalJson: string;
  createdBy: string;
  createdAt: string;
}

export type TaskStatus =
  | "intake"
  | "contextualizing"
  | "drafting_trd"
  | "awaiting_trd_approval"
  | "planning"
  | "executing"
  | "verifying"
  | "awaiting_acceptance"
  | "blocked"
  | "closed";

export type TaskOutcome = "completed" | "cancelled";

export interface Task {
  taskId: string;
  version: number;
  status: TaskStatus;
  goal: string;
  prd: VersionedRef;
  contextManifest?: VersionedRef;
  trd?: VersionedRef;
  outcome?: TaskOutcome;
  blockedReason?: string;
  resumeToStatus?: TaskStatus;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type ApprovalGate = "trd_approval" | "run_authorization";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "approved_with_conditions"
  | "changes_requested"
  | "rejected"
  | "withdrawn"
  | "expired"
  | "revoked";

export type ApprovalDecisionValue = "approved" | "approved_with_conditions" | "changes_requested" | "rejected";

export interface ApprovalCondition {
  conditionId: string;
  description: string;
  owner: string;
  requiredBefore: "planning" | "execution" | "acceptance";
  verificationMethod: string;
  evidenceRefs: readonly string[];
}

export interface Approval {
  approvalId: string;
  taskId: string;
  version: number;
  gate: ApprovalGate;
  subjectType: string;
  subject: VersionedRef;
  policyVersion: string;
  requiredRoles: readonly string[];
  requestedBy: string;
  status: ApprovalStatus;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalDecision {
  decisionId: string;
  approvalId: string;
  approvalVersion: number;
  decision: ApprovalDecisionValue;
  authorityId: string;
  authorityRole: string;
  reason: string;
  conditions: readonly ApprovalCondition[];
  evidenceRefs: readonly string[];
  decidedAt: string;
}

export type RunStatus = "awaiting_authorization" | "authorized" | "active" | "stopping" | "blocked" | "settled";
export type RunOutcome = "completed" | "cancelled" | "superseded" | "rejected" | "failed";
export type PendingRunOutcome = "cancelled" | "superseded" | "failed";

export interface Run {
  runId: string;
  taskId: string;
  version: number;
  manifestDigest: string;
  authorizationApprovalId: string;
  status: RunStatus;
  outcome?: RunOutcome;
  pendingOutcome?: PendingRunOutcome;
  resumeToStatus?: "authorized" | "active" | "stopping";
  reasonCode?: string;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
}

export type RuntimeRole = "coordinator" | "executor" | "verifier";

export interface RolePlan {
  rolePlanId: string;
  role: RuntimeRole;
  model: {
    provider: string;
    modelId: string;
    thinkingLevel?: string;
  };
  resources: readonly VersionedRef[];
  skills: readonly VersionedRef[];
  prompts: readonly VersionedRef[];
  tools: readonly {
    name: string;
    version: string;
    definitionDigest: string;
    policyRef: VersionedRef;
  }[];
  isolationProfile: VersionedRef;
  credentialBindings: readonly {
    bindingId: string;
    provider: string;
    scopes: readonly string[];
  }[];
  limits: {
    maxAttempts: number;
    timeoutMs: number;
  };
}

export interface RunManifestV1 {
  schemaVersion: "1";
  runId: string;
  composedAt: string;
  composedBy: string;
  task: {
    taskId: string;
    taskRevision: number;
  };
  inputs: {
    prd: VersionedRef;
    contextManifest: VersionedRef;
    trd: VersionedRef;
    executionPlan: VersionedRef;
    prerequisiteApprovals: readonly VersionedRef[];
  };
  target: {
    repositoryId: string;
    baseCommit: string;
    approvedPatch?: VersionedRef;
    allowedPaths: readonly string[];
  };
  runtime: {
    harnessCommit: string;
    adapter: VersionedRef;
    piPackages: readonly VersionedRef[];
    environment: VersionedRef;
  };
  roles: readonly RolePlan[];
  policies: {
    policyRefs: readonly VersionedRef[];
    approvalConditions: readonly ApprovalCondition[];
    maxRoleRuns: number;
    maxDurationMs: number;
  };
  verification: {
    acceptanceCriteria: VersionedRef;
    requiredChecks: readonly VersionedRef[];
    requiredEvidence: readonly string[];
  };
}

export type RoleRunStatus = "prepared" | "starting" | "running" | "settling" | "blocked" | "settled";
export type RoleRunOutcome = "succeeded" | "failed" | "aborted" | "interrupted";
export type RuntimeOutcome = "completed" | "error" | "aborted" | "incomplete" | "unknown";

export interface RoleRun {
  roleRunId: string;
  runId: string;
  rolePlanId: string;
  role: RuntimeRole;
  attempt: number;
  version: number;
  status: RoleRunStatus;
  outcome?: RoleRunOutcome;
  runtimeOutcome?: RuntimeOutcome;
  sessionId?: string;
  inputArtifacts: readonly VersionedRef[];
  outputArtifacts: readonly VersionedRef[];
  toolOperationRefs: readonly string[];
  evidenceRefs: readonly string[];
  leaseOwner?: string;
  leaseExpiresAt?: string;
  leaseToken: number;
  preparedAt: string;
  startedAt?: string;
  runtimeEndedAt?: string;
  settledAt?: string;
  errorCode?: string;
  sanitizedError?: string;
}

export type VerificationVerdict = "pass" | "fail" | "blocked";
export type VerificationFindingClass = "implementation" | "trd" | "context" | "prd" | "external";

export interface RecoveryAction {
  actionId: string;
  kind:
    | "deliver_outbox"
    | "start_role_run"
    | "interrupt_lost_session"
    | "continue_settlement"
    | "continue_stop"
    | "await_manual_resolution";
  taskId?: string;
  runId?: string;
  roleRunId?: string;
  refId?: string;
}

export interface StoredTransition {
  transitionId: string;
  ownerId: string;
  commandId: string;
  fromStatus?: string;
  toStatus: string;
  fromVersion?: number;
  toVersion: number;
  actor: Actor;
  reasonCode: string;
  refs: readonly VersionedRef[];
  evidenceRefs: readonly string[];
  leaseToken?: number;
  occurredAt: string;
}
