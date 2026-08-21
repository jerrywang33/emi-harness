import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneError, SqliteControlPlane } from "../src/index.js";
import {
  TestClock,
  TestIds,
  artifact,
  authorizeRun,
  coordinator,
  deliveryAuthority,
  executorWorker,
  ref,
  registerPrerequisites,
  verifierWorker,
} from "./fixtures.js";

const directories: string[] = [];

async function databaseFixture(): Promise<{ directory: string; path: string; clock: TestClock; controlPlane: SqliteControlPlane }> {
  const directory = await mkdtemp(join(tmpdir(), "emi-control-plane-"));
  directories.push(directory);
  const path = join(directory, "control-plane.db");
  const clock = new TestClock();
  return { directory, path, clock, controlPlane: new SqliteControlPlane({ databasePath: path, clock, idGenerator: new TestIds() }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SqliteControlPlane lifecycle", () => {
  it("persists and restores the complete authorized Executor, Verifier, and acceptance path", async () => {
    const fixture = await databaseFixture();
    const controlPlane = fixture.controlPlane;
    const prerequisites = registerPrerequisites(controlPlane);
    const { manifestDigest } = authorizeRun(controlPlane, prerequisites);

    const executor = controlPlane.prepareRoleRun({
      commandId: "prepare-executor",
      actor: coordinator,
      taskId: "task-1",
      expectedTaskVersion: 6,
      runId: "run-1",
      expectedRunVersion: 2,
      roleRunId: "role-executor-1",
      rolePlanId: "executor-plan",
      inputArtifacts: [ref(prerequisites.trd)],
    });
    expect(executor.status).toBe("prepared");

    const executorLease = controlPlane.acquireRoleRunLease({
      commandId: "lease-executor",
      actor: executorWorker,
      taskId: "task-1",
      expectedTaskVersion: 6,
      runId: "run-1",
      expectedRunVersion: 2,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 1,
      leaseOwner: executorWorker.actorId,
      leaseDurationMs: 60_000,
    });
    expect(executorLease.run).toMatchObject({ status: "active", version: 3 });
    expect(executorLease.roleRun.leaseToken).toBe(1);
    const executorRunning = controlPlane.markRoleRunRunning({
      commandId: "run-executor",
      actor: executorWorker,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 2,
      leaseToken: 1,
      sessionId: "pi-session-executor",
    });
    expect(executorRunning.sessionId).toBe("pi-session-executor");
    controlPlane.markRoleRunSettling({
      commandId: "settle-executor-runtime",
      actor: executorWorker,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 3,
      leaseToken: 1,
      runtimeOutcome: "completed",
      toolOperationRefs: [],
    });
    const executionResultInput = artifact("execution-result-1", "execution_result", {
      taskId: "task-1",
      runId: "run-1",
      manifestDigest,
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      outputCommit: "1111111111111111111111111111111111111111",
      checks: [{ id: "check-1", status: "passed" }],
    }, executorWorker.actorId);
    const execution = controlPlane.submitExecutionForVerification({
      commandId: "submit-execution",
      actor: executorWorker,
      taskId: "task-1",
      expectedTaskVersion: 6,
      runId: "run-1",
      expectedRunVersion: 3,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 4,
      leaseToken: 1,
      executionResult: executionResultInput,
      toolOperationRefs: [],
      evidenceRefs: ["executor-test-report"],
    });
    expect(execution.task.status).toBe("verifying");
    expect(execution.roleRun).toMatchObject({ status: "settled", outcome: "succeeded" });

    controlPlane.prepareRoleRun({
      commandId: "prepare-verifier",
      actor: coordinator,
      taskId: "task-1",
      expectedTaskVersion: 7,
      runId: "run-1",
      expectedRunVersion: 3,
      roleRunId: "role-verifier-1",
      rolePlanId: "verifier-plan",
      inputArtifacts: [execution.executionResult],
    });
    controlPlane.acquireRoleRunLease({
      commandId: "lease-verifier",
      actor: verifierWorker,
      taskId: "task-1",
      expectedTaskVersion: 7,
      runId: "run-1",
      expectedRunVersion: 3,
      roleRunId: "role-verifier-1",
      expectedRoleRunVersion: 1,
      leaseOwner: verifierWorker.actorId,
      leaseDurationMs: 60_000,
    });
    controlPlane.markRoleRunRunning({
      commandId: "run-verifier",
      actor: verifierWorker,
      roleRunId: "role-verifier-1",
      expectedRoleRunVersion: 2,
      leaseToken: 1,
      sessionId: "pi-session-verifier",
    });
    controlPlane.markRoleRunSettling({
      commandId: "settle-verifier-runtime",
      actor: verifierWorker,
      roleRunId: "role-verifier-1",
      expectedRoleRunVersion: 3,
      leaseToken: 1,
      runtimeOutcome: "completed",
      toolOperationRefs: [],
    });
    const verificationResultInput = artifact("verification-result-1", "verification_result", {
      taskId: "task-1",
      runId: "run-1",
      executionResult: { ...ref(executionResultInput) },
      verdict: "pass",
      checks: [{ id: "check-1", status: "passed" }],
    }, verifierWorker.actorId);
    const verification = controlPlane.submitVerificationResult({
      commandId: "submit-verification",
      actor: verifierWorker,
      taskId: "task-1",
      expectedTaskVersion: 7,
      runId: "run-1",
      expectedRunVersion: 3,
      roleRunId: "role-verifier-1",
      expectedRoleRunVersion: 4,
      leaseToken: 1,
      verificationResult: verificationResultInput,
      executionResult: execution.executionResult,
      verdict: "pass",
      reasonCode: "all_checks_passed",
      evidenceRefs: ["verifier-test-report"],
    });
    expect(verification.task.status).toBe("awaiting_acceptance");
    expect(verification.roleRun.sessionId).toBe("pi-session-verifier");
    expect(controlPlane.getRoleRun("role-executor-1").sessionId).not.toBe(verification.roleRun.sessionId);

    const unrelatedPass = artifact("verification-result-unrelated", "verification_result", {
      taskId: "task-1",
      runId: "run-1",
      executionResult: { id: "other-execution", version: "1", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      verdict: "pass",
    });
    controlPlane.registerArtifact({ commandId: "register-unrelated-pass", actor: coordinator, artifact: unrelatedPass });
    expect(() =>
      controlPlane.acceptDelivery({
        commandId: "accept-unrelated-pass",
        actor: deliveryAuthority,
        taskId: "task-1",
        expectedTaskVersion: 8,
        runId: "run-1",
        expectedRunVersion: 3,
        executionResult: execution.executionResult,
        verificationResult: ref(unrelatedPass),
        evidenceRefs: ["human-acceptance"],
        reason: "Wrong verification object",
      }),
    ).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "digest_mismatch" }));
    expect(controlPlane.getTask("task-1")).toMatchObject({ status: "awaiting_acceptance", version: 8 });

    const accepted = controlPlane.acceptDelivery({
      commandId: "accept-delivery",
      actor: deliveryAuthority,
      taskId: "task-1",
      expectedTaskVersion: 8,
      runId: "run-1",
      expectedRunVersion: 3,
      executionResult: execution.executionResult,
      verificationResult: verification.verificationResult,
      evidenceRefs: ["human-acceptance"],
      reason: "Verified delivery accepted",
    });
    expect(accepted.task).toMatchObject({ status: "closed", outcome: "completed", version: 9 });
    expect(accepted.run).toMatchObject({ status: "settled", outcome: "completed", version: 4 });
    expect(controlPlane.planRecovery().some((action) => action.kind === "deliver_outbox")).toBe(true);
    expect(controlPlane.listTaskTransitions("task-1")).toHaveLength(9);
    expect(controlPlane.listRunTransitions("run-1")).toHaveLength(4);

    const originalCreate = controlPlane.createTask({
      commandId: "create-task",
      actor: coordinator,
      taskId: "task-1",
      goal: "Implement safeguarded account status",
      prd: ref(prerequisites.prd),
    });
    expect(originalCreate).toMatchObject({ version: 1, status: "intake" });
    expect(controlPlane.listTaskTransitions("task-1")).toHaveLength(9);
    expect(() =>
      controlPlane.startContextualization({
        commandId: "stale-command",
        actor: coordinator,
        taskId: "task-1",
        expectedTaskVersion: 1,
        reason: "stale",
      }),
    ).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "version_conflict" }));

    controlPlane.close();
    const restored = new SqliteControlPlane({ databasePath: fixture.path, clock: fixture.clock, idGenerator: new TestIds() });
    expect(restored.getTask("task-1")).toMatchObject({ status: "closed", outcome: "completed", version: 9 });
    expect(restored.getRun("run-1")).toMatchObject({ status: "settled", outcome: "completed", version: 4 });
    expect(restored.getRunManifest("run-1").digest).toBe(manifestDigest);
    restored.close();
  });

  it("rolls back a rejected approval command without partial history", async () => {
    const fixture = await databaseFixture();
    const controlPlane = fixture.controlPlane;
    const prerequisites = registerPrerequisites(controlPlane);
    controlPlane.createTask({ commandId: "create-task", actor: coordinator, taskId: "task-1", goal: "Goal", prd: ref(prerequisites.prd) });
    controlPlane.startContextualization({ commandId: "start-context", actor: coordinator, taskId: "task-1", expectedTaskVersion: 1, reason: "ready" });
    controlPlane.completeContextualization({ commandId: "complete-context", actor: coordinator, taskId: "task-1", expectedTaskVersion: 2, contextManifest: ref(prerequisites.context), evidenceRefs: [] });
    controlPlane.submitTrdForApproval({
      commandId: "submit-trd",
      actor: coordinator,
      taskId: "task-1",
      expectedTaskVersion: 3,
      trd: ref(prerequisites.trd),
      approvalId: "approval-trd-1",
      policyVersion: "approval-policy-1",
      requiredRoles: ["architecture_authority"],
    });

    expect(() =>
      controlPlane.recordApprovalDecision({
        commandId: "self-approve",
        actor: { ...coordinator, roles: ["architecture_authority"] },
        approvalId: "approval-trd-1",
        expectedApprovalVersion: 1,
        expectedTaskVersion: 4,
        decisionId: "bad-decision",
        authorityRole: "architecture_authority",
        decision: "approved",
        reason: "self approval",
        conditions: [],
        evidenceRefs: [],
      }),
    ).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "permission_denied" }));
    expect(controlPlane.getApproval("approval-trd-1")).toMatchObject({ status: "pending", version: 1 });
    expect(controlPlane.getTask("task-1")).toMatchObject({ status: "awaiting_trd_approval", version: 4 });
    controlPlane.close();
  });
});
