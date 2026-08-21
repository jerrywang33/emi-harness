import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneError, SqliteControlPlane } from "../src/index.js";
import {
  TestClock,
  TestIds,
  authorizeRun,
  coordinator,
  executorWorker,
  ref,
  registerPrerequisites,
} from "./fixtures.js";

const directories: string[] = [];

async function fixture(): Promise<{ controlPlane: SqliteControlPlane; clock: TestClock }> {
  const directory = await mkdtemp(join(tmpdir(), "emi-control-recovery-"));
  directories.push(directory);
  const clock = new TestClock();
  return {
    controlPlane: new SqliteControlPlane({
      databasePath: join(directory, "state.db"),
      clock,
      idGenerator: new TestIds(),
    }),
    clock,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RoleRun recovery and fencing", () => {
  it("reacquires an expired startup lease and rejects the old worker token", async () => {
    const { controlPlane, clock } = await fixture();
    const prerequisites = registerPrerequisites(controlPlane);
    authorizeRun(controlPlane, prerequisites);
    controlPlane.prepareRoleRun({
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
    expect(controlPlane.planRecovery()).toContainEqual(
      expect.objectContaining({ kind: "start_role_run", roleRunId: "role-executor-1" }),
    );
    controlPlane.acquireRoleRunLease({
      commandId: "lease-1",
      actor: executorWorker,
      taskId: "task-1",
      expectedTaskVersion: 6,
      runId: "run-1",
      expectedRunVersion: 2,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 1,
      leaseOwner: executorWorker.actorId,
      leaseDurationMs: 1_000,
    });
    expect(controlPlane.planRecovery()).not.toContainEqual(
      expect.objectContaining({ kind: "start_role_run", roleRunId: "role-executor-1" }),
    );
    clock.advance(1_001);
    expect(controlPlane.planRecovery()).toContainEqual(
      expect.objectContaining({ kind: "start_role_run", roleRunId: "role-executor-1" }),
    );
    const replacementWorker = { ...executorWorker, actorId: "worker-executor-replacement" };
    const reacquired = controlPlane.acquireRoleRunLease({
      commandId: "lease-2",
      actor: replacementWorker,
      taskId: "task-1",
      expectedTaskVersion: 6,
      runId: "run-1",
      expectedRunVersion: 3,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 2,
      leaseOwner: replacementWorker.actorId,
      leaseDurationMs: 60_000,
    });
    expect(reacquired.roleRun.leaseToken).toBe(2);
    expect(() =>
      controlPlane.markRoleRunRunning({
        commandId: "stale-worker",
        actor: executorWorker,
        roleRunId: "role-executor-1",
        expectedRoleRunVersion: 3,
        leaseToken: 1,
        sessionId: "stale-session",
      }),
    ).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "fencing_rejected" }));
    controlPlane.markRoleRunRunning({
      commandId: "replacement-running",
      actor: replacementWorker,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 3,
      leaseToken: 2,
      sessionId: "replacement-session",
    });
    expect(controlPlane.planRecovery()).toContainEqual(
      expect.objectContaining({ kind: "interrupt_lost_session", roleRunId: "role-executor-1" }),
    );
    controlPlane.markRoleRunSettling({
      commandId: "replacement-settling",
      actor: replacementWorker,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 4,
      leaseToken: 2,
      runtimeOutcome: "incomplete",
      toolOperationRefs: [],
    });
    expect(controlPlane.planRecovery()).toContainEqual(
      expect.objectContaining({ kind: "continue_settlement", roleRunId: "role-executor-1" }),
    );
    controlPlane.settleRoleRun({
      commandId: "replacement-interrupted",
      actor: replacementWorker,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 5,
      leaseToken: 2,
      outcome: "interrupted",
      errorCode: "worker_restarted",
      sanitizedError: "The in-memory Pi Session was lost",
      evidenceRefs: ["recovery-observation"],
    });
    const retry = controlPlane.prepareRoleRun({
      commandId: "prepare-executor-retry",
      actor: coordinator,
      taskId: "task-1",
      expectedTaskVersion: 6,
      runId: "run-1",
      expectedRunVersion: 3,
      roleRunId: "role-executor-2",
      rolePlanId: "executor-plan",
      inputArtifacts: [ref(prerequisites.trd)],
    });
    expect(retry.attempt).toBe(2);
    controlPlane.close();
  });

  it("stops an active RoleRun before settling a cancellation", async () => {
    const { controlPlane } = await fixture();
    const prerequisites = registerPrerequisites(controlPlane);
    authorizeRun(controlPlane, prerequisites);
    controlPlane.prepareRoleRun({
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
    controlPlane.acquireRoleRunLease({
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
    controlPlane.markRoleRunRunning({
      commandId: "executor-running",
      actor: executorWorker,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 2,
      leaseToken: 1,
      sessionId: "executor-session",
    });
    controlPlane.markRoleRunSettling({
      commandId: "executor-settling",
      actor: executorWorker,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 3,
      leaseToken: 1,
      runtimeOutcome: "aborted",
      toolOperationRefs: [],
    });
    const cancelled = controlPlane.cancelTask({
      commandId: "cancel-task",
      actor: { actorId: "human-owner", actorType: "human", roles: ["task_owner"] },
      taskId: "task-1",
      expectedTaskVersion: 6,
      expectedRunVersion: 3,
      reasonCode: "user_cancelled",
      evidenceRefs: ["cancel-request"],
    });
    expect(cancelled.task).toMatchObject({ status: "blocked", resumeToStatus: "executing" });
    expect(cancelled.run).toMatchObject({ status: "stopping", pendingOutcome: "cancelled" });
    expect(() =>
      controlPlane.finishRunStop({
        commandId: "finish-too-early",
        actor: coordinator,
        taskId: "task-1",
        expectedTaskVersion: 7,
        runId: "run-1",
        expectedRunVersion: 4,
        outcome: "cancelled",
        evidenceRefs: [],
      }),
    ).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "invalid_transition" }));
    controlPlane.settleRoleRun({
      commandId: "settle-aborted-role",
      actor: executorWorker,
      roleRunId: "role-executor-1",
      expectedRoleRunVersion: 4,
      leaseToken: 1,
      outcome: "aborted",
      errorCode: "task_cancelled",
      sanitizedError: "Task owner cancelled the run",
      evidenceRefs: ["abort-confirmation"],
    });
    const finished = controlPlane.finishRunStop({
      commandId: "finish-cancel",
      actor: coordinator,
      taskId: "task-1",
      expectedTaskVersion: 7,
      runId: "run-1",
      expectedRunVersion: 4,
      outcome: "cancelled",
      evidenceRefs: ["abort-confirmation"],
    });
    expect(finished.task).toMatchObject({ status: "closed", outcome: "cancelled" });
    expect(finished.run).toMatchObject({ status: "settled", outcome: "cancelled" });
    controlPlane.close();
  });
});
