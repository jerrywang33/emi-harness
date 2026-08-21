import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AssuranceError,
  digestJson,
  NodeCheckRunner,
  type CheckDefinitionV1,
  type CheckExecutionRequest,
} from "../src/index.js";

const directories: string[] = [];

function request(definition: CheckDefinitionV1, id = "check-1"): CheckExecutionRequest {
  return {
    taskId: "task-1",
    runId: "run-1",
    roleRunId: "role-verifier-1",
    target: {
      repositoryId: "local-target",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
    },
    check: { ref: { id, version: "1", digest: digestJson(definition) }, definition },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("NodeCheckRunner", () => {
  it("runs fixed Node scripts without a shell and records pass, fail, and bounded output", async () => {
    const root = await mkdtemp(join(tmpdir(), "emi-check-runner-"));
    directories.push(root);
    await mkdir(join(root, "checks"));
    await writeFile(join(root, "checks/pass.mjs"), "process.stdout.write('PASS\\n');\n", "utf8");
    await writeFile(join(root, "checks/fail.mjs"), "process.stderr.write('FAILED-CHECK\\n'); process.exit(2);\n", "utf8");
    const runner = await NodeCheckRunner.create({ repositoryId: "local-target", workspaceRoot: root, maxOutputBytes: 5 });

    const passDefinition: CheckDefinitionV1 = {
      schemaVersion: "1",
      runner: "node_script",
      scriptPath: "checks/pass.mjs",
      args: [],
      timeoutMs: 5_000,
      expectedExitCode: 0,
    };
    const passed = await runner.run(request(passDefinition));
    expect(passed).toMatchObject({ outcome: "passed", exitCode: 0, stdout: "PASS\n", stdoutTruncated: false });

    const failDefinition: CheckDefinitionV1 = { ...passDefinition, scriptPath: "checks/fail.mjs" };
    const failed = await runner.run(request(failDefinition, "check-2"));
    expect(failed).toMatchObject({ outcome: "failed", exitCode: 2, stderr: "FAILE", stderrTruncated: true });
  });

  it("marks timeouts blocked and rejects digest or symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "emi-check-boundary-"));
    const outside = await mkdtemp(join(tmpdir(), "emi-check-outside-"));
    directories.push(root, outside);
    await mkdir(join(root, "checks"));
    await writeFile(join(root, "checks/slow.mjs"), "setInterval(() => {}, 1000);\n", "utf8");
    await writeFile(join(outside, "escape.mjs"), "process.exit(0);\n", "utf8");
    await symlink(join(outside, "escape.mjs"), join(root, "checks/escape.mjs"));
    const runner = await NodeCheckRunner.create({ repositoryId: "local-target", workspaceRoot: root, maxTimeoutMs: 1_000 });
    const slow: CheckDefinitionV1 = {
      schemaVersion: "1",
      runner: "node_script",
      scriptPath: "checks/slow.mjs",
      args: [],
      timeoutMs: 20,
      expectedExitCode: 0,
    };
    await expect(runner.run(request(slow))).resolves.toMatchObject({ outcome: "blocked", errorCode: "check_timeout" });

    const escaped: CheckDefinitionV1 = { ...slow, scriptPath: "checks/escape.mjs", timeoutMs: 100 };
    await expect(runner.run(request(escaped, "check-escape"))).rejects.toEqual(
      expect.objectContaining<Partial<AssuranceError>>({ code: "invalid_check" }),
    );
    await expect(
      runner.run({
        ...request(slow, "check-drift"),
        check: { ref: { id: "check-drift", version: "1", digest: `sha256:${"0".repeat(64)}` }, definition: slow },
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<AssuranceError>>({ code: "invalid_check" }));
  });
});
