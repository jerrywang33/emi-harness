import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { IsolatedToolExecutorPort, OperationIntent } from "../src/index.js";
import { sha256Text, SubprocessWorkspaceExecutor } from "../src/index.js";
import { gatewayFixture, request } from "./fixtures.js";

const directories: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "emi-tool-recovery-"));
  directories.push(root);
  await mkdir(join(root, "src"));
  return root;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class LostResultExecutor implements IsolatedToolExecutorPort {
  executeCount = 0;

  constructor(
    private readonly delegate: IsolatedToolExecutorPort,
    private readonly applyBeforeLoss: boolean,
  ) {}

  async execute(intent: OperationIntent, signal?: AbortSignal): Promise<never> {
    this.executeCount += 1;
    if (this.applyBeforeLoss) {
      await this.delegate.execute(intent, signal);
    }
    throw new Error("simulated transport loss after dispatch");
  }

  reconcile(intent: OperationIntent) {
    return this.delegate.reconcile(intent);
  }
}

describe("Tool Operation recovery", () => {
  it("reconciles an applied unknown operation without executing it twice", async () => {
    const root = await workspace();
    const databasePath = join(root, "gateway.sqlite");
    const subprocess = await SubprocessWorkspaceExecutor.create({ repositoryId: "local-target", workspaceRoot: root });
    const lostResult = new LostResultExecutor(subprocess, true);
    const first = await gatewayFixture({ databasePath, workspaceRoot: root, executor: lostResult });
    const invoked = await first.gateway.invoke(request());
    expect(invoked.operation.status).toBe("unknown");
    expect(lostResult.executeCount).toBe(1);
    expect(await readFile(join(root, "src/value.ts"), "utf8")).toBe("export const value = 1;\n");
    first.gateway.close();

    const reopened = await gatewayFixture({ databasePath, workspaceRoot: root, executor: subprocess });
    expect(reopened.gateway.listUnsettledOperations("role-executor-1")).toHaveLength(1);
    const reconciled = await reopened.gateway.reconcile(invoked.operation.operationId);
    expect(reconciled.operation.status).toBe("succeeded");
    expect(reconciled.result).toMatchObject({ source: "reconciliation", outcome: "succeeded" });
    expect(reopened.gateway.listTransitions(invoked.operation.operationId).map((item) => item.toStatus)).toEqual([
      "authorized",
      "executing",
      "unknown",
      "succeeded",
    ]);
    expect(lostResult.executeCount).toBe(1);
    reopened.gateway.close();
  });

  it("distinguishes a proved non-application from a diverged target", async () => {
    const root = await workspace();
    const subprocess = await SubprocessWorkspaceExecutor.create({ repositoryId: "local-target", workspaceRoot: root });
    const lostWithoutApply = new LostResultExecutor(subprocess, false);
    const first = await gatewayFixture({
      databasePath: join(root, "not-applied.sqlite"),
      workspaceRoot: root,
      executor: lostWithoutApply,
    });
    const unknown = await first.gateway.invoke(request());
    const notApplied = await first.gateway.reconcile(unknown.operation.operationId);
    expect(notApplied.operation.status).toBe("failed");
    expect(notApplied.result).toMatchObject({ source: "reconciliation", errorCode: "not_applied" });
    first.gateway.close();

    const second = await gatewayFixture({
      databasePath: join(root, "diverged.sqlite"),
      workspaceRoot: root,
      executor: new LostResultExecutor(subprocess, false),
    });
    const anotherUnknown = await second.gateway.invoke(request({ callId: "diverged-call" }));
    await writeFile(join(root, "src/value.ts"), "external change\n", "utf8");
    const diverged = await second.gateway.reconcile(anotherUnknown.operation.operationId);
    expect(diverged.operation.status).toBe("unknown");
    expect(diverged.operation.errorCode).toBe("target_diverged");
    expect(diverged.result).toBeUndefined();
    expect(diverged.operation.version).toBe(4);
    second.gateway.close();
  });

  it("rejects a symlink parent inside an otherwise allowed path", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "emi-tool-outside-"));
    directories.push(outside);
    await symlink(outside, join(root, "linked"));
    const fixture = await gatewayFixture({ databasePath: join(root, "gateway.sqlite"), workspaceRoot: root });
    fixture.state.allowedPaths = ["linked/value.ts"];
    const outcome = await fixture.gateway.invoke(
      request({
        callId: "symlink-call",
        input: { path: "linked/value.ts", content: "escape\n", expectedDigest: "absent" },
      }),
    );
    expect(outcome.operation.status).toBe("failed");
    expect(outcome.result).toMatchObject({ errorCode: "unsafe_target" });
    await expect(readFile(join(outside, "value.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    fixture.gateway.close();
  });

  it("returns idempotent success when the desired digest is already present", async () => {
    const root = await workspace();
    const content = "export const value = 1;\n";
    await writeFile(join(root, "src/value.ts"), content, "utf8");
    const fixture = await gatewayFixture({ databasePath: join(root, "gateway.sqlite"), workspaceRoot: root });
    const outcome = await fixture.gateway.invoke(request());
    expect(outcome.operation.status).toBe("succeeded");
    expect(outcome.result?.output).toMatchObject({ alreadyApplied: true, contentDigest: sha256Text(content) });
    fixture.gateway.close();
  });
});
