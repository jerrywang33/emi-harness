import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  type IsolatedToolExecutorPort,
  LOCAL_WORKSPACE_ISOLATION_REF,
  type OperationIntent,
  type SqliteToolGateway,
  ToolGatewayError,
  WORKSPACE_WRITE_POLICY_REF,
  WORKSPACE_WRITE_TOOL_REF,
} from "../src/index.js";
import { gatewayFixture, request } from "./fixtures.js";

const directories: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "emi-tool-gateway-"));
  directories.push(root);
  await mkdir(join(root, "src"));
  return root;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SqliteToolGateway", () => {
  it("pins the v1 tool, policy, and isolation definitions", () => {
    expect(WORKSPACE_WRITE_TOOL_REF.definitionDigest).toBe(
      "sha256:79f13d63d73dc5b723e050535d33a858f1a3f727601b5692d4cb26bf4864b84a",
    );
    expect(WORKSPACE_WRITE_POLICY_REF.digest).toBe(
      "sha256:6997f880029987b95560b173ac47af9e680fe80c5242864e9a7f12b075808d78",
    );
    expect(LOCAL_WORKSPACE_ISOLATION_REF.digest).toBe(
      "sha256:c3f148b44d9886cd56b46088c93b8accdd03389b38f98bbbfff661696c53c227",
    );
  });

  it("commits the Intent and executing state before calling the Executor", async () => {
    const root = await workspace();
    let gateway: SqliteToolGateway | undefined;
    let observed = false;
    const executor: IsolatedToolExecutorPort = {
      execute: async (intent: OperationIntent) => {
        if (gateway === undefined) throw new Error("Gateway was not initialized");
        expect(gateway.getOperation(intent.operationId).status).toBe("executing");
        expect(gateway.getIntent(intent.operationId).inputDigest).toBe(intent.inputDigest);
        observed = true;
        return { outcome: "succeeded", output: { observed: true }, evidenceRefs: ["intent-was-durable"] };
      },
      reconcile: async () => ({ outcome: "unknown", output: {}, evidenceRefs: [] }),
    };
    const fixture = await gatewayFixture({
      databasePath: join(root, "gateway.sqlite"),
      workspaceRoot: root,
      executor,
    });
    gateway = fixture.gateway;
    const outcome = await gateway.invoke(request());
    expect(outcome.operation.status).toBe("succeeded");
    expect(observed).toBe(true);
    gateway.close();
  });

  it("persists authorization and intent before an isolated atomic write", async () => {
    const root = await workspace();
    const databasePath = join(root, "gateway.sqlite");
    const first = await gatewayFixture({ databasePath, workspaceRoot: root });
    const outcome = await first.gateway.invoke(request());

    expect(outcome.operation.status).toBe("succeeded");
    expect(outcome.decision).toMatchObject({ outcome: "allow", reasonCodes: ["manifest_tool_and_path_allowed"] });
    expect(first.gateway.getIntent(outcome.operation.operationId)).toMatchObject({
      toolName: "workspace.write_text",
      allowedPath: "src/value.ts",
      repositoryId: "local-target",
    });
    expect(outcome.result).toMatchObject({ outcome: "succeeded", source: "execution" });
    expect(first.gateway.listTransitions(outcome.operation.operationId).map((item) => item.toStatus)).toEqual([
      "authorized",
      "executing",
      "succeeded",
    ]);
    expect(await readFile(join(root, "src/value.ts"), "utf8")).toBe("export const value = 1;\n");
    first.gateway.close();

    const rawDatabase = new DatabaseSync(databasePath);
    expect(() => rawDatabase.prepare("UPDATE operation_intents SET input_json = '{}' WHERE operation_id = ?").run(
      outcome.operation.operationId,
    )).toThrow(/operation intents are immutable/);
    expect(() => rawDatabase.prepare("DELETE FROM operation_results WHERE operation_id = ?").run(
      outcome.operation.operationId,
    )).toThrow(/operation results are immutable/);
    rawDatabase.close();

    const reopened = await gatewayFixture({ databasePath, workspaceRoot: root });
    const replay = await reopened.gateway.invoke(request());
    expect(replay.operation.operationId).toBe(outcome.operation.operationId);
    expect(reopened.gateway.listTransitions(outcome.operation.operationId)).toHaveLength(3);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    reopened.gateway.close();
  });

  it("rejects stale fencing, expired or wrong roles, definition drift, and unapproved paths", async () => {
    const root = await workspace();
    const fixture = await gatewayFixture({ databasePath: join(root, "gateway.sqlite"), workspaceRoot: root });

    const stale = await fixture.gateway.invoke(request({ leaseToken: 6, callId: "stale-call" }));
    expect(stale.operation.status).toBe("denied");
    expect(stale.decision.reasonCodes).toEqual(["authorization_denied"]);

    fixture.state.leaseExpiresAt = "2026-08-20T23:59:59.000Z";
    const expired = await fixture.gateway.invoke(request({ callId: "expired-call" }));
    expect(expired.operation.status).toBe("denied");
    expect(expired.decision.reasonCodes).toEqual(["authorization_denied"]);
    fixture.state.leaseExpiresAt = "2026-08-21T01:00:00.000Z";

    fixture.state.role = "verifier";
    const verifier = await fixture.gateway.invoke(request({ callId: "verifier-call" }));
    expect(verifier.operation.status).toBe("denied");
    expect(verifier.decision.reasonCodes).toEqual(["authorization_denied"]);
    fixture.state.role = "executor";

    const wrongDefinition = await fixture.gateway.invoke(
      request({
        callId: "definition-call",
        tool: { ...WORKSPACE_WRITE_TOOL_REF, definitionDigest: `sha256:${"0".repeat(64)}` },
      }),
    );
    expect(wrongDefinition.operation.status).toBe("denied");
    expect(wrongDefinition.decision.reasonCodes).toEqual(["tool_definition_mismatch"]);

    const wrongPath = await fixture.gateway.invoke(
      request({
        callId: "path-call",
        input: { path: "src/not-allowed.ts", content: "blocked\n", expectedDigest: "absent" },
      }),
    );
    expect(wrongPath.operation.status).toBe("denied");
    expect(wrongPath.decision.reasonCodes).toContain("path_not_allowed");
    await expect(readFile(join(root, "src/value.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "src/not-allowed.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    fixture.gateway.close();
  });

  it("uses compare-and-set and rejects reuse of a tool call with different input", async () => {
    const root = await workspace();
    await writeFile(join(root, "src/value.ts"), "original\n", "utf8");
    const fixture = await gatewayFixture({ databasePath: join(root, "gateway.sqlite"), workspaceRoot: root });
    const failed = await fixture.gateway.invoke(
      request({ input: { path: "src/value.ts", content: "replacement\n", expectedDigest: `sha256:${"0".repeat(64)}` } }),
    );
    expect(failed.operation.status).toBe("failed");
    expect(failed.result).toMatchObject({ errorCode: "precondition_failed" });
    expect(await readFile(join(root, "src/value.ts"), "utf8")).toBe("original\n");

    await expect(
      fixture.gateway.invoke(
        request({ input: { path: "src/value.ts", content: "different request\n", expectedDigest: "absent" } }),
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<ToolGatewayError>>({ code: "idempotency_conflict" }));
    fixture.gateway.close();
  });
});
