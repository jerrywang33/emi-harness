import { describe, expect, it } from "vitest";

import {
  AssuranceError,
  AssuranceService,
  digestJson,
  SqliteEvidenceStore,
  type CheckDefinitionV1,
  type CheckObservation,
  type CheckRunnerPort,
  type VerificationSubmission,
  type VersionedRef,
} from "../src/index.js";

const definition: CheckDefinitionV1 = {
  schemaVersion: "1",
  runner: "node_script",
  scriptPath: "checks/verify.mjs",
  args: [],
  timeoutMs: 5_000,
  expectedExitCode: 0,
};
const checkRef: VersionedRef = { id: "check-1", version: "1", digest: digestJson(definition) };
const executionResult: VersionedRef = {
  id: "execution-result-1",
  version: "1",
  digest: `sha256:${"2".repeat(64)}`,
};

class FixedRunner implements CheckRunnerPort {
  constructor(private readonly outcome: CheckObservation["outcome"]) {}

  async run(request: Parameters<CheckRunnerPort["run"]>[0]): Promise<CheckObservation> {
    return {
      schemaVersion: "1",
      taskId: request.taskId,
      runId: request.runId,
      roleRunId: request.roleRunId,
      repositoryId: request.target.repositoryId,
      baseCommit: request.target.baseCommit,
      check: request.check.ref,
      runner: "node_script",
      scriptPath: request.check.definition.scriptPath,
      args: [],
      outcome: this.outcome,
      expectedExitCode: 0,
      ...(this.outcome === "blocked" ? { errorCode: "check_timeout" } : { exitCode: this.outcome === "passed" ? 0 : 1 }),
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      startedAt: "2026-08-21T00:00:00.000Z",
      endedAt: "2026-08-21T00:00:01.000Z",
    };
  }
}

async function runChecks(outcome: CheckObservation["outcome"]) {
  const store = new SqliteEvidenceStore({ databasePath: ":memory:", clock: { now: () => "2026-08-21T00:00:02.000Z" } });
  const service = new AssuranceService(store, new FixedRunner(outcome));
  const checks = await service.runRequiredChecks({
    taskId: "task-1",
    runId: "run-1",
    roleRunId: "role-verifier-1",
    target: { repositoryId: "local-target", baseCommit: "0123456789abcdef0123456789abcdef01234567" },
    requiredChecks: [checkRef],
    checks: [{ ref: checkRef, definition }],
  });
  return { store, service, checks };
}

function verificationInput(
  checks: Awaited<ReturnType<typeof runChecks>>["checks"],
  submission: VerificationSubmission,
) {
  return {
    evidenceId: "verification-assurance-1",
    taskId: "task-1",
    runId: "run-1",
    manifestDigest: `sha256:${"3".repeat(64)}`,
    target: { repositoryId: "local-target", baseCommit: "0123456789abcdef0123456789abcdef01234567" },
    executionResult,
    executor: { roleRunId: "role-executor-1", sessionId: "session-executor" },
    verifier: { roleRunId: "role-verifier-1", sessionId: "session-verifier" },
    requiredChecks: [checkRef],
    checks,
    submission,
  } as const;
}

describe("AssuranceService", () => {
  it("seals PASS only with independent sessions and authoritative passing checks", async () => {
    const fixture = await runChecks("passed");
    const result = fixture.service.sealVerification(
      verificationInput(fixture.checks, { verdict: "pass", reason: "All required checks passed", findings: [] }),
    );
    expect(result.content).toMatchObject({
      taskId: "task-1",
      runId: "run-1",
      verdict: "pass",
      executor: { roleRunId: "role-executor-1", sessionId: "session-executor" },
      verifier: { roleRunId: "role-verifier-1", sessionId: "session-verifier" },
    });
    expect(fixture.store.get({ id: result.evidence.evidenceId, version: "1", digest: result.evidence.digest })).toEqual(
      result.evidence,
    );
    fixture.store.close();
  });

  it("rejects PASS on failed checks and accepts an implementation FAIL", async () => {
    const fixture = await runChecks("failed");
    expect(() => fixture.service.sealVerification(
      verificationInput(fixture.checks, { verdict: "pass", reason: "Agent claimed pass", findings: [] }),
    )).toThrowError(expect.objectContaining<Partial<AssuranceError>>({ code: "verification_rejected" }));

    const failed = fixture.service.sealVerification(
      verificationInput(fixture.checks, {
        verdict: "fail",
        findingClass: "implementation",
        reason: "Required check failed",
        findings: ["check-1 exited with failure"],
      }),
    );
    expect(failed.content).toMatchObject({ verdict: "fail", findingClass: "implementation" });
    fixture.store.close();
  });

  it("rejects mixed Evidence and reused Executor/Verifier sessions", async () => {
    const fixture = await runChecks("passed");
    const mixed = structuredClone(fixture.checks);
    mixed[0]!.observation.stdout = "not the stored observation";
    expect(() => fixture.service.sealVerification(
      verificationInput(mixed, { verdict: "pass", reason: "Mixed evidence", findings: [] }),
    )).toThrowError(expect.objectContaining<Partial<AssuranceError>>({ code: "verification_rejected" }));

    const sameSession = verificationInput(fixture.checks, { verdict: "pass", reason: "Same session", findings: [] });
    expect(() => fixture.service.sealVerification({
      ...sameSession,
      verifier: { roleRunId: "role-verifier-1", sessionId: "session-executor" },
    })).toThrowError(expect.objectContaining<Partial<AssuranceError>>({ code: "verification_rejected" }));
    fixture.store.close();
  });
});
