import { canonicalizeJson, digestJson, isSha256 } from "./canonical-json.js";
import { fail } from "./errors.js";
import { formatEvidenceRef } from "./sqlite-evidence-store.js";
import type {
  CheckRunnerPort,
  EvidenceStorePort,
  JsonObject,
  JsonValue,
  RecordedCheck,
  RunRequiredChecksInput,
  VerificationAssuranceInput,
  VerificationAssuranceResult,
  VersionedRef,
} from "./types.js";

function refKey(ref: VersionedRef): string {
  return `${ref.id}\u0000${ref.version}\u0000${ref.digest}`;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return refKey(left) === refKey(right);
}

function assertExactChecks(required: readonly VersionedRef[], actual: readonly VersionedRef[]): void {
  if (required.length === 0) {
    fail("verification_rejected", "RunManifest must require at least one deterministic check");
  }
  const requiredKeys = [...required].map(refKey).sort();
  const actualKeys = [...actual].map(refKey).sort();
  if (
    new Set(requiredKeys).size !== requiredKeys.length ||
    new Set(actualKeys).size !== actualKeys.length ||
    requiredKeys.join("\n") !== actualKeys.join("\n")
  ) {
    fail("verification_rejected", "Check set does not exactly match RunManifest requiredChecks");
  }
}

export class AssuranceService {
  constructor(
    private readonly evidenceStore: EvidenceStorePort,
    private readonly checkRunner: CheckRunnerPort,
  ) {}

  async runRequiredChecks(input: RunRequiredChecksInput): Promise<RecordedCheck[]> {
    assertExactChecks(input.requiredChecks, input.checks.map((check) => check.ref));
    const recorded: RecordedCheck[] = [];
    for (const check of input.checks) {
      const observation = await this.checkRunner.run({
        taskId: input.taskId,
        runId: input.runId,
        roleRunId: input.roleRunId,
        target: input.target,
        check,
      });
      const evidence = this.evidenceStore.put({
        evidenceId: `check-${digestJson({ runId: input.runId, roleRunId: input.roleRunId, check: check.ref }).slice(7, 31)}`,
        version: "1",
        kind: "check_result",
        taskId: input.taskId,
        runId: input.runId,
        roleRunId: input.roleRunId,
        producer: { producerId: "assurance.node-check-runner", producerType: "system" },
        subjectRefs: [check.ref],
        content: JSON.parse(canonicalizeJson(observation)) as JsonValue,
      });
      recorded.push({ observation, evidence, evidenceRef: formatEvidenceRef(evidence) });
    }
    return recorded;
  }

  sealVerification(input: VerificationAssuranceInput): VerificationAssuranceResult {
    if (!isSha256(input.manifestDigest)) fail("invalid_input", "Verification requires a Manifest SHA-256");
    if (
      input.executor.roleRunId === input.verifier.roleRunId ||
      input.executor.sessionId === input.verifier.sessionId
    ) {
      fail("verification_rejected", "Executor and Verifier must use different RoleRuns and Sessions");
    }
    assertExactChecks(input.requiredChecks, input.checks.map((check) => check.observation.check));
    for (const check of input.checks) {
      const observation = check.observation;
      if (
        observation.taskId !== input.taskId ||
        observation.runId !== input.runId ||
        observation.roleRunId !== input.verifier.roleRunId ||
        observation.repositoryId !== input.target.repositoryId ||
        observation.baseCommit !== input.target.baseCommit ||
        check.evidence.subjectRefs.length !== 1 ||
        check.evidence.subjectRefs[0] === undefined ||
        !sameRef(observation.check, check.evidence.subjectRefs[0])
      ) {
        fail("verification_rejected", `Check Evidence binding is invalid: ${observation.check.id}`);
      }
      const stored = this.evidenceStore.get({
        id: check.evidence.evidenceId,
        version: check.evidence.version,
        digest: check.evidence.digest,
      });
      if (
        stored.kind !== "check_result" ||
        stored.taskId !== input.taskId ||
        stored.runId !== input.runId ||
        stored.roleRunId !== input.verifier.roleRunId ||
        formatEvidenceRef(stored) !== check.evidenceRef ||
        digestJson(stored.content) !== digestJson(observation)
      ) {
        fail("verification_rejected", `Check Evidence is not authoritative: ${observation.check.id}`);
      }
    }
    const outcomes = input.checks.map((check) => check.observation.outcome);
    if (input.submission.verdict === "pass" && outcomes.some((outcome) => outcome !== "passed")) {
      fail("verification_rejected", "PASS requires every RunManifest check to pass");
    }
    if (outcomes.includes("blocked") && input.submission.verdict !== "blocked") {
      fail("verification_rejected", "A blocked deterministic check requires a blocked verification result");
    }
    if (outcomes.includes("failed") && input.submission.verdict !== "fail") {
      fail("verification_rejected", "A failed deterministic check requires a failed verification result");
    }
    if (input.submission.verdict === "fail" && !["context", "implementation", "prd", "trd"].includes(input.submission.findingClass ?? "")) {
      fail("verification_rejected", "FAIL requires an implementation, TRD, Context, or PRD finding class");
    }
    if (input.submission.verdict === "blocked" && input.submission.findingClass !== "external") {
      fail("verification_rejected", "BLOCKED requires external findingClass");
    }
    if (input.submission.verdict === "pass" && input.submission.findingClass !== undefined) {
      fail("verification_rejected", "PASS cannot include a findingClass");
    }
    if (input.submission.reason.trim().length === 0) fail("verification_rejected", "Verification reason is required");
    if (
      input.submission.findings.some((finding) => finding.trim().length === 0) ||
      new Set(input.submission.findings).size !== input.submission.findings.length
    ) {
      fail("verification_rejected", "Verification findings must be unique non-empty strings");
    }
    if (input.submission.verdict !== "pass" && input.submission.findings.length === 0) {
      fail("verification_rejected", "Non-PASS verification requires at least one finding");
    }

    const checks = input.checks.map((check) => ({
      check: { ...check.observation.check },
      outcome: check.observation.outcome,
      evidenceRef: check.evidenceRef,
    }));
    const content: JsonObject = {
      schemaVersion: "1",
      taskId: input.taskId,
      runId: input.runId,
      manifestDigest: input.manifestDigest,
      executionResult: { ...input.executionResult },
      verdict: input.submission.verdict,
      ...(input.submission.findingClass === undefined ? {} : { findingClass: input.submission.findingClass }),
      reason: input.submission.reason,
      findings: [...input.submission.findings],
      target: { ...input.target },
      executor: { ...input.executor },
      verifier: { ...input.verifier },
      checks,
    };
    const evidence = this.evidenceStore.put({
      evidenceId: input.evidenceId,
      version: "1",
      kind: "verification_assurance",
      taskId: input.taskId,
      runId: input.runId,
      roleRunId: input.verifier.roleRunId,
      producer: { producerId: "assurance.verification-gate", producerType: "system" },
      subjectRefs: [input.executionResult, ...input.requiredChecks],
      content,
    });
    return { content, evidence, evidenceRef: formatEvidenceRef(evidence) };
  }
}
