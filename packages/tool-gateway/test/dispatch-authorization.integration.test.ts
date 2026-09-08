import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ControlPlaneRoleRunAuthority,
  WorkspaceWritePolicy,
  type IsolatedToolExecutorPort,
  type OperationIntent,
  type RoleRunAuthorityPort,
  type RoleRunAuthoritySnapshot,
  type SqliteToolGateway,
  type ToolInvocationOutcome,
  type ToolInvocationRequest,
} from "../src/index.js";
import { TestClock, TestIds, authorityFixture, authorizedState, gatewayFixture, request } from "./fixtures.js";

const directories: string[] = [];
const gateways = new Set<SqliteToolGateway>();

afterEach(async () => {
  for (const gateway of gateways) gateway.close();
  gateways.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function checkpoint() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function context() {
  const root = await mkdtemp(join(tmpdir(), "emi-dispatch-authorization-"));
  directories.push(root);
  await mkdir(join(root, "src"));
  const state = authorizedState();
  const clock = new TestClock();
  const executed: OperationIntent[] = [];
  const executor: IsolatedToolExecutorPort = {
    execute: async (intent) => {
      executed.push(intent);
      return { outcome: "succeeded", output: {}, evidenceRefs: [] };
    },
    reconcile: async () => ({ outcome: "unknown", output: {}, evidenceRefs: [] }),
  };
  return {
    root, databasePath: join(root, "gateway.sqlite"), state, clock, executed, executor,
    authority: new ControlPlaneRoleRunAuthority(authorityFixture(state), clock),
  };
}

type Context = Awaited<ReturnType<typeof context>>;
type Overrides = Pick<Parameters<typeof gatewayFixture>[0], "authority" | "policy" | "ids" | "executor">;

async function openGateway(current: Context, overrides: Overrides = {}): Promise<SqliteToolGateway> {
  const { gateway } = await gatewayFixture({
    databasePath: current.databasePath, workspaceRoot: current.root,
    state: current.state, clock: current.clock, executor: current.executor,
    ...overrides,
  });
  gateways.add(gateway);
  return gateway;
}

class DispatchPreparationIds extends TestIds {
  private transitions = 0;

  constructor(private readonly duringPreparation: () => void) {
    super();
  }

  override next(prefix: string): string {
    // The initial authorization is transition 1. Transition 2 is created after the
    // executing UPDATE, inside its transaction and before the final authority check.
    if (prefix === "transition" && ++this.transitions === 2) this.duringPreparation();
    return super.next(prefix);
  }
}

function expectFailedBeforeExecution(outcome: ToolInvocationOutcome, current: Context, errorCode = "authorization_expired_before_execution"): void {
  expect(outcome.operation).toMatchObject({ status: "failed", errorCode });
  expect(outcome.result).toMatchObject({ outcome: "failed", errorCode });
  expect(outcome.decision.outcome).toBe("allow");
  expect(current.executed).toEqual([]);
}

describe("synchronous final dispatch authorization", () => {
  it("rechecks a recovered authorized Operation after its asynchronous authorization snapshot becomes stale", async () => {
    const current = await context();
    const first = await openGateway(current, {
      ids: new DispatchPreparationIds(() => { throw new Error("Simulated failure while persisting dispatch preparation"); }),
    });
    await expect(first.invoke(request())).rejects.toThrow("Simulated failure while persisting dispatch preparation");
    const original = first.listUnsettledOperations()[0];
    expect(original?.status).toBe("authorized");
    if (original === undefined) throw new Error("Expected the durable authorized Operation");
    const originalIntent = first.getIntent(original.operationId);
    const originalDecision = first.getDecision(original.operationId);
    expect(first.listTransitions(original.operationId).map((transition) => transition.toStatus)).toEqual(["authorized"]);
    expect(current.executed).toEqual([]);
    first.close();
    gateways.delete(first);

    const snapshotReady = checkpoint();
    const releaseSnapshot = checkpoint();
    const reopened = await openGateway(current, {
      authority: {
        authorize: async (input) => {
          const snapshot = await current.authority.authorize(input);
          snapshotReady.resolve();
          await releaseSnapshot.promise;
          return snapshot;
        },
        authorizeForDispatch: (input) => current.authority.authorizeForDispatch(input),
      },
    });
    const invocation = reopened.invoke(request());
    try {
      await snapshotReady.promise;
      current.state.approvalSupported = false;
      current.state.runStatus = "stopping";
      releaseSnapshot.resolve();
      const outcome = await invocation;
      expectFailedBeforeExecution(outcome, current);
      expect(outcome.operation.operationId).toBe(original.operationId);
      expect(reopened.listOperationsForRoleRun(original.roleRunId)).toHaveLength(1);
      expect(reopened.getIntent(original.operationId)).toEqual(originalIntent);
      expect(reopened.getDecision(original.operationId)).toEqual(originalDecision);
      expect(reopened.listUnsettledOperations()).toEqual([]);
    } finally {
      releaseSnapshot.resolve();
      await invocation.catch(() => undefined);
    }
  });

  it.each([
    { boundary: "lease expiry", errorCode: "authorization_expired_before_execution" },
    { boundary: "abort", errorCode: "cancelled_before_execution" },
  ])("rejects $boundary occurring while the executing state is being committed", async ({ boundary, errorCode }) => {
    const current = await context();
    const cancellation = new AbortController();
    const gateway = await openGateway(current, {
      ids: new DispatchPreparationIds(() => {
        if (boundary === "lease expiry") current.clock.set(current.state.leaseExpiresAt);
        else cancellation.abort();
      }),
    });
    const outcome = await gateway.invoke(request(), cancellation.signal);
    expectFailedBeforeExecution(outcome, current, errorCode);
    expect(gateway.listTransitions(outcome.operation.operationId)).toEqual([
      expect.objectContaining({ toStatus: "authorized" }),
      expect.objectContaining({ toStatus: "executing", reasonCode: "dispatch_prepared" }),
      expect.objectContaining({ toStatus: "failed" }),
    ]);
  });

  it.each(["missing", "throws", "resolved Promise", "rejected Promise", "thenable"] as const)("fails closed when the final authority method is %s", async (behavior) => {
    const current = await context();
    const adapter: {
      authorize(input: ToolInvocationRequest): Promise<RoleRunAuthoritySnapshot>;
      authorizeForDispatch?: (input: ToolInvocationRequest) => unknown;
    } = { authorize: (input) => current.authority.authorize(input) };
    if (behavior !== "missing") {
      adapter.authorizeForDispatch = (input) => {
        if (behavior === "throws") throw new Error("Final local authority is unavailable");
        const snapshot = current.authority.authorizeForDispatch(input);
        if (behavior === "resolved Promise") return Promise.resolve(snapshot);
        if (behavior === "rejected Promise") return Promise.reject(new Error("Async final authority failed"));
        return { then: (resolve: (value: RoleRunAuthoritySnapshot) => void) => resolve(snapshot) };
      };
    }
    const gateway = await openGateway(current, { authority: adapter as unknown as RoleRunAuthorityPort });
    const outcome = await gateway.invoke(request());
    expectFailedBeforeExecution(outcome, current);
    expect(gateway.listUnsettledOperations()).toEqual([]);
    // Rejected promises/thenables must also be consumed, not become unhandled rejections.
    await Promise.resolve();
  });

  it.each(["repository", "base commit", "tool", "allowed paths"] as const)("rejects a final %s snapshot that no longer permits the persisted Intent", async (drift) => {
    const current = await context();
    const gateway = await openGateway(current, {
      authority: {
        authorize: (input) => current.authority.authorize(input),
        authorizeForDispatch: (input) => {
          const snapshot = current.authority.authorizeForDispatch(input);
          if (drift === "repository") return { ...snapshot, repositoryId: "another-target" };
          if (drift === "base commit") return { ...snapshot, baseCommit: "f".repeat(40) };
          if (drift === "tool") return { ...snapshot, tool: { ...snapshot.tool, definitionDigest: `sha256:${"0".repeat(64)}` } };
          return { ...snapshot, allowedPaths: ["src/another-path.ts"] };
        },
      },
    });
    const outcome = await gateway.invoke(request());
    expectFailedBeforeExecution(outcome, current);
    expect(gateway.getIntent(outcome.operation.operationId)).toMatchObject({
      repositoryId: "local-target", allowedPath: "src/value.ts", input: request().input,
    });
  });

  it("rejects a final policy evaluation that changes the normalized input", async () => {
    const current = await context();
    const policy = new WorkspaceWritePolicy();
    let evaluations = 0;
    const gateway = await openGateway(current, {
      policy: {
        ref: policy.ref,
        evaluate: (authority, input) => {
          evaluations += 1;
          const evaluation = policy.evaluate(authority, input);
          if (evaluations === 2 && evaluation.normalizedInput !== undefined) {
            return { ...evaluation, normalizedInput: { ...evaluation.normalizedInput, content: "Changed by a later policy evaluation" } };
          }
          return evaluation;
        },
      },
    });
    const outcome = await gateway.invoke(request());
    expect(evaluations).toBe(2);
    expectFailedBeforeExecution(outcome, current);
    expect(gateway.getIntent(outcome.operation.operationId).input).toEqual(request().input);
  });

  it("enters execute before a revocation microtask queued by the final check and rejects subsequent work", async () => {
    const current = await context();
    const events: string[] = [];
    const gateway = await openGateway(current, {
      authority: {
        authorize: (input) => current.authority.authorize(input),
        authorizeForDispatch: (input) => {
          const snapshot = current.authority.authorizeForDispatch(input);
          queueMicrotask(() => {
            events.push("revoked");
            current.state.approvalSupported = false;
            current.state.runStatus = "stopping";
          });
          return snapshot;
        },
      },
      executor: {
        execute: (intent, abortSignal) => {
          events.push("execute");
          expect(current.state.runStatus).toBe("active");
          return current.executor.execute(intent, abortSignal);
        },
        reconcile: (intent) => current.executor.reconcile(intent),
      },
    });
    const dispatched = await gateway.invoke(request());
    expect(dispatched.operation.status).toBe("succeeded");
    expect(events).toEqual(["execute", "revoked"]);
    const later = await gateway.invoke(request({ callId: "after-revocation" }));
    expect(later.operation.status).toBe("denied");
    expect(current.executed).toHaveLength(1);
    expect(events).toEqual(["execute", "revoked"]);
  });
});
