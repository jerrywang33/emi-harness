import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ControlPlaneRoleRunAuthority,
  SqliteToolGateway,
  SubprocessWorkspaceExecutor,
  WORKSPACE_WRITE_TOOL,
  WORKSPACE_WRITE_TOOL_REF,
  WorkspaceWritePolicy,
  type ToolInvocationOutcome,
  type ToolInvocationRequest,
} from "@emi-harness/tool-gateway";
import { describe, expect, it } from "vitest";

import { TestClock, coordinator, createHarnessFixture, executorWorker, type HarnessFixture } from "./fixtures.js";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function prepareExecutor(fixture: HarnessFixture): ToolInvocationRequest {
  const controlPlane = fixture.controlPlane;
  const task = controlPlane.getTask("task-1");
  const run = controlPlane.getRun("run-1");
  const prepared = controlPlane.prepareRoleRun({
    commandId: "dispatch:prepare", actor: coordinator, taskId: task.taskId, expectedTaskVersion: task.version,
    runId: run.runId, expectedRunVersion: run.version, roleRunId: "role-executor-1", rolePlanId: "executor-plan",
    inputArtifacts: [fixture.manifest.inputs.trd],
  });
  const leased = controlPlane.acquireRoleRunLease({
    commandId: "dispatch:lease", actor: executorWorker, taskId: task.taskId, expectedTaskVersion: task.version,
    runId: run.runId, expectedRunVersion: run.version, roleRunId: prepared.roleRunId, expectedRoleRunVersion: prepared.version,
    leaseOwner: executorWorker.actorId, leaseDurationMs: 60_000,
  });
  const running = controlPlane.markRoleRunRunning({
    commandId: "dispatch:running", actor: executorWorker, roleRunId: prepared.roleRunId,
    expectedRoleRunVersion: leased.roleRun.version, leaseToken: leased.roleRun.leaseToken,
    sessionId: "dispatch-test-session",
  });
  return {
    runId: run.runId,
    roleRunId: running.roleRunId,
    leaseToken: running.leaseToken,
    callId: "write-status",
    tool: WORKSPACE_WRITE_TOOL_REF,
    input: { path: "src/status.ts", content: "export const status = 'safeguarded';\n", expectedDigest: "absent" },
  };
}

function revokeRunAuthorization(fixture: HarnessFixture): void {
  const controlPlane = fixture.controlPlane;
  const task = controlPlane.getTask("task-1");
  const run = controlPlane.getRun("run-1");
  const approval = controlPlane.getApproval(run.authorizationApprovalId);
  controlPlane.invalidateApproval({
    commandId: "dispatch:revoke",
    actor: { actorId: "human-revoker", actorType: "human", roles: ["approval_revoker"] },
    approvalId: approval.approvalId,
    expectedApprovalVersion: approval.version,
    expectedTaskVersion: task.version,
    expectedRunVersion: run.version,
    action: "revoked",
    reasonCode: "authorization_revoked",
    evidenceRefs: ["human-revocation"],
  });
}

describe("approval revocation at the Gateway dispatch boundary", () => {
  it("prevents a write when approval is revoked after the initial authority snapshot but before dispatch", async () => {
    const fixture = await createHarnessFixture();
    const initialAuthorizationReady = signal();
    const releaseInitialAuthorization = signal();
    let gateway: SqliteToolGateway | undefined;
    let invocation: Promise<ToolInvocationOutcome> | undefined;
    let executeCalls = 0;
    try {
      const request = prepareExecutor(fixture);
      const clock = new TestClock();
      const authority = new ControlPlaneRoleRunAuthority(fixture.controlPlane, clock);
      const subprocess = await SubprocessWorkspaceExecutor.create({
        repositoryId: fixture.manifest.target.repositoryId, workspaceRoot: fixture.root,
      });
      gateway = new SqliteToolGateway({
        databasePath: join(fixture.stateRoot, "revocation-before-dispatch.sqlite"),
        authority: {
          authorize: async (input) => {
            const snapshot = await authority.authorize(input);
            initialAuthorizationReady.resolve();
            await releaseInitialAuthorization.promise;
            return snapshot;
          },
          authorizeForDispatch: (input) => authority.authorizeForDispatch(input),
        },
        executor: {
          execute: (intent, abortSignal) => {
            executeCalls += 1;
            return subprocess.execute(intent, abortSignal);
          },
          reconcile: (intent) => subprocess.reconcile(intent),
        },
        registrations: [{ definition: WORKSPACE_WRITE_TOOL, policy: new WorkspaceWritePolicy() }],
        clock,
      });
      invocation = gateway.invoke(request);
      await initialAuthorizationReady.promise;
      revokeRunAuthorization(fixture);
      expect(fixture.controlPlane.getApproval("approval-run-1").status).toBe("revoked");
      expect(fixture.controlPlane.getTask("task-1").status).toBe("blocked");
      expect(fixture.controlPlane.getRun("run-1").status).toBe("stopping");
      expect(gateway.listOperationsForRoleRun(request.roleRunId)).toEqual([]);

      releaseInitialAuthorization.resolve();
      const outcome = await invocation;
      expect(executeCalls).toBe(0);
      expect(outcome.operation).toMatchObject({ status: "failed", errorCode: "authorization_expired_before_execution" });
      expect(outcome.result).toMatchObject({ outcome: "failed", errorCode: "authorization_expired_before_execution" });
      expect(outcome.decision.outcome).toBe("allow");
      expect(gateway.getIntent(outcome.operation.operationId).input).toEqual(request.input);
      expect(gateway.listUnsettledOperations(request.roleRunId)).toEqual([]);
      await expect(readFile(join(fixture.root, "src/status.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(fixture.runtime.starts).toEqual([]);
    } finally {
      releaseInitialAuthorization.resolve();
      await invocation?.catch(() => undefined);
      gateway?.close();
      await fixture.close();
    }
  });

  it("reconciles an already dispatched write after revocation and a lost result without executing again", async () => {
    const fixture = await createHarnessFixture();
    const writeApplied = signal();
    const releaseLostResult = signal();
    let gateway: SqliteToolGateway | undefined;
    let invocation: Promise<ToolInvocationOutcome> | undefined;
    let executeCalls = 0;
    try {
      const request = prepareExecutor(fixture);
      const clock = new TestClock();
      const subprocess = await SubprocessWorkspaceExecutor.create({
        repositoryId: fixture.manifest.target.repositoryId, workspaceRoot: fixture.root,
      });
      gateway = new SqliteToolGateway({
        databasePath: join(fixture.stateRoot, "revocation-after-dispatch.sqlite"),
        authority: new ControlPlaneRoleRunAuthority(fixture.controlPlane, clock),
        executor: {
          execute: async (intent, abortSignal) => {
            executeCalls += 1;
            await subprocess.execute(intent, abortSignal);
            writeApplied.resolve();
            await releaseLostResult.promise;
            throw new Error("Simulated loss of the isolated worker result");
          },
          reconcile: (intent) => subprocess.reconcile(intent),
        },
        registrations: [{ definition: WORKSPACE_WRITE_TOOL, policy: new WorkspaceWritePolicy() }],
        clock,
      });
      invocation = gateway.invoke(request);
      await writeApplied.promise;
      const dispatched = gateway.listOperationsForRoleRun(request.roleRunId);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.status).toBe("executing");
      expect(await readFile(join(fixture.root, "src/status.ts"), "utf8")).toBe(request.input.content);

      revokeRunAuthorization(fixture);
      releaseLostResult.resolve();
      const unknown = await invocation;
      expect(unknown.operation.status).toBe("unknown");
      expect(unknown.result).toBeUndefined();
      const reconciled = await gateway.reconcile(unknown.operation.operationId);
      expect(reconciled.operation.status).toBe("succeeded");
      expect(reconciled.result).toMatchObject({ outcome: "succeeded", source: "reconciliation" });
      expect(executeCalls).toBe(1);
      expect(fixture.controlPlane.getApproval("approval-run-1").status).toBe("revoked");
      expect(fixture.controlPlane.getTask("task-1").status).toBe("blocked");
      expect(fixture.controlPlane.getRun("run-1").status).toBe("stopping");
      expect(gateway.listUnsettledOperations(request.roleRunId)).toEqual([]);
      expect(await readFile(join(fixture.root, "src/status.ts"), "utf8")).toBe(request.input.content);
      expect(fixture.runtime.starts).toEqual([]);
    } finally {
      releaseLostResult.resolve();
      await invocation?.catch(() => undefined);
      gateway?.close();
      await fixture.close();
    }
  });
});
