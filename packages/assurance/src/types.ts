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

export type EvidenceKind = "check_result" | "execution" | "runtime" | "tool_operation" | "verification_assurance";
export type EvidenceProducerType = "agent" | "system" | "worker";

export interface EvidenceRecordInput {
  evidenceId: string;
  version: string;
  kind: EvidenceKind;
  taskId: string;
  runId: string;
  roleRunId?: string;
  producer: {
    producerId: string;
    producerType: EvidenceProducerType;
  };
  subjectRefs: readonly VersionedRef[];
  content: JsonValue;
}

export interface EvidenceRecord extends EvidenceRecordInput {
  digest: string;
  canonicalJson: string;
  createdAt: string;
}

export interface EvidenceStorePort {
  put(input: EvidenceRecordInput): EvidenceRecord;
  get(ref: VersionedRef): EvidenceRecord;
}

export interface CheckDefinitionV1 {
  schemaVersion: "1";
  runner: "node_script";
  scriptPath: string;
  args: readonly string[];
  timeoutMs: number;
  expectedExitCode: number;
}

export interface CheckExecutionRequest {
  taskId: string;
  runId: string;
  roleRunId: string;
  target: {
    repositoryId: string;
    baseCommit: string;
  };
  check: {
    ref: VersionedRef;
    definition: CheckDefinitionV1;
  };
}

export type CheckOutcome = "blocked" | "failed" | "passed";

export interface CheckObservation {
  schemaVersion: "1";
  taskId: string;
  runId: string;
  roleRunId: string;
  repositoryId: string;
  baseCommit: string;
  check: VersionedRef;
  runner: "node_script";
  scriptPath: string;
  args: readonly string[];
  outcome: CheckOutcome;
  expectedExitCode: number;
  exitCode?: number;
  signal?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  startedAt: string;
  endedAt: string;
  errorCode?: string;
}

export interface CheckRunnerPort {
  run(request: CheckExecutionRequest): Promise<CheckObservation>;
}

export interface RecordedCheck {
  observation: CheckObservation;
  evidence: EvidenceRecord;
  evidenceRef: string;
}

export interface RunRequiredChecksInput {
  taskId: string;
  runId: string;
  roleRunId: string;
  target: { repositoryId: string; baseCommit: string };
  requiredChecks: readonly VersionedRef[];
  checks: readonly { ref: VersionedRef; definition: CheckDefinitionV1 }[];
}

export interface VerificationSubmission {
  verdict: "blocked" | "fail" | "pass";
  findingClass?: "context" | "external" | "implementation" | "prd" | "trd";
  reason: string;
  findings: readonly string[];
}

export interface VerificationAssuranceInput {
  evidenceId: string;
  taskId: string;
  runId: string;
  manifestDigest: string;
  target: { repositoryId: string; baseCommit: string };
  executionResult: VersionedRef;
  executor: { roleRunId: string; sessionId: string };
  verifier: { roleRunId: string; sessionId: string };
  requiredChecks: readonly VersionedRef[];
  checks: readonly RecordedCheck[];
  submission: VerificationSubmission;
}

export interface VerificationAssuranceResult {
  content: JsonObject;
  evidence: EvidenceRecord;
  evidenceRef: string;
}
