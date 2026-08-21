export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface VersionedRef {
  id: string;
  version: string;
  digest: string;
}

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface ToolPlanRef {
  name: string;
  version: string;
  definitionDigest: string;
  policyRef: VersionedRef;
}

export interface ToolDefinitionV1 {
  name: string;
  version: string;
  description: string;
  inputSchema: JsonObject;
  definitionDigest: string;
}

export interface ToolInvocationRequest {
  runId: string;
  roleRunId: string;
  leaseToken: number;
  callId: string;
  tool: ToolPlanRef;
  input: JsonObject;
}

export type ToolOperationStatus = "authorized" | "denied" | "executing" | "failed" | "succeeded" | "unknown";

export interface ToolOperation {
  operationId: string;
  version: number;
  status: ToolOperationStatus;
  idempotencyKey: string;
  requestDigest: string;
  runId: string;
  roleRunId: string;
  leaseToken: number;
  callId: string;
  tool: ToolPlanRef;
  errorCode?: string;
  sanitizedError?: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export interface PolicyDecision {
  decisionId: string;
  operationId: string;
  outcome: "allow" | "deny";
  reasonCodes: readonly string[];
  authorityDigest: string;
  policyRef: VersionedRef;
  decidedAt: string;
}

export interface OperationIntent {
  intentId: string;
  operationId: string;
  schemaVersion: "1";
  toolName: string;
  toolVersion: string;
  input: JsonObject;
  inputDigest: string;
  repositoryId: string;
  baseCommit: string;
  allowedPath: string;
  isolationProfile: VersionedRef;
  createdAt: string;
}

export interface OperationResult {
  resultId: string;
  operationId: string;
  outcome: "failed" | "succeeded";
  source: "execution" | "reconciliation";
  output: JsonObject;
  outputDigest: string;
  evidenceRefs: readonly string[];
  errorCode?: string;
  sanitizedError?: string;
  createdAt: string;
}

export interface OperationTransition {
  transitionId: string;
  operationId: string;
  fromStatus?: ToolOperationStatus;
  toStatus: ToolOperationStatus;
  fromVersion?: number;
  toVersion: number;
  reasonCode: string;
  occurredAt: string;
}

export interface ToolInvocationOutcome {
  operation: ToolOperation;
  decision: PolicyDecision;
  result?: OperationResult;
}

export interface RoleRunAuthoritySnapshot {
  runId: string;
  roleRunId: string;
  rolePlanId: string;
  role: "coordinator" | "executor" | "verifier";
  leaseToken: number;
  leaseExpiresAt: string;
  repositoryId: string;
  baseCommit: string;
  allowedPaths: readonly string[];
  tool: ToolPlanRef;
  isolationProfile: VersionedRef;
}

export interface RoleRunAuthorityPort {
  authorize(request: ToolInvocationRequest): Promise<RoleRunAuthoritySnapshot>;
}

export interface ToolPolicyEvaluation {
  outcome: "allow" | "deny";
  reasonCodes: readonly string[];
  normalizedInput?: JsonObject;
  allowedPath?: string;
}

export interface ToolPolicyPort {
  readonly ref: VersionedRef;
  evaluate(authority: RoleRunAuthoritySnapshot, input: JsonObject): ToolPolicyEvaluation;
}

export interface IsolatedExecutionResult {
  outcome: "failed" | "succeeded";
  output: JsonObject;
  evidenceRefs: readonly string[];
  errorCode?: string;
  sanitizedError?: string;
}

export interface ReconciliationResult {
  outcome: "applied" | "not_applied" | "unknown";
  output: JsonObject;
  evidenceRefs: readonly string[];
  errorCode?: string;
  sanitizedError?: string;
}

export interface IsolatedToolExecutorPort {
  execute(intent: OperationIntent, signal?: AbortSignal): Promise<IsolatedExecutionResult>;
  reconcile(intent: OperationIntent): Promise<ReconciliationResult>;
}
