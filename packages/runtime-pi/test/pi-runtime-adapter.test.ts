import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeTool } from "../src/contracts.js";
import { PiRuntimeAdapter } from "../src/pi-runtime-adapter.js";

const directories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "emi-runtime-pi-"));
  directories.push(directory);
  return directory;
}

function probeTool(name = "gateway_probe"): RuntimeTool {
  return {
    name,
    description: "Controlled gateway probe",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    execute: async ({ input }) => ({ text: String(input.value) }),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PiRuntimeAdapter", () => {
  it("starts a session with only explicit tools and ignores ambient Pi model configuration", async () => {
    const root = await tempDirectory();
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "models.json"), "AMBIENT_MODEL_CONFIG_MUST_NOT_LOAD", "utf8");
    const adapter = new PiRuntimeAdapter({ agentDir, resolveApiKey: async () => "controlled-test-key" });
    const session = await adapter.startSession({
      runId: "run-1",
      roleRunId: "role-run-1",
      role: "executor",
      cwd: root,
      model: { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "off" },
      resources: { systemPrompt: { source: "emi://prompt/system", content: "controlled" } },
      tools: [probeTool()],
    });

    expect(session.sessionId).not.toBe("");
    expect(session.runId).toBe("run-1");
    expect(session.roleRunId).toBe("role-run-1");
    expect(session.role).toBe("executor");
    expect(session.activeToolNames).toEqual(["gateway_probe"]);
    session.dispose();
  });

  it("starts with no tools when the run manifest contains no tools", async () => {
    const root = await tempDirectory();
    const adapter = new PiRuntimeAdapter({
      agentDir: join(root, "agent"),
      resolveApiKey: async () => "controlled-test-key",
    });
    const session = await adapter.startSession({
      runId: "run-2",
      roleRunId: "role-run-2",
      role: "verifier",
      cwd: root,
      model: { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "off" },
      resources: {},
      tools: [],
    });

    expect(session.activeToolNames).toEqual([]);
    session.dispose();
  });

  it("rejects Pi built-in tools before creating a session", async () => {
    const root = await tempDirectory();
    const adapter = new PiRuntimeAdapter({
      agentDir: join(root, "agent"),
      resolveApiKey: async () => "controlled-test-key",
    });

    await expect(
      adapter.startSession({
        runId: "run-3",
        roleRunId: "role-run-3",
        role: "executor",
        cwd: root,
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        resources: {},
        tools: [probeTool("bash")],
      }),
    ).rejects.toThrow("Pi built-in tool is not allowed");
  });

  it("rejects relative working directories", async () => {
    const root = await tempDirectory();
    const adapter = new PiRuntimeAdapter({
      agentDir: join(root, "agent"),
      resolveApiKey: async () => "controlled-test-key",
    });

    await expect(
      adapter.startSession({
        runId: "run-4",
        roleRunId: "role-run-4",
        role: "executor",
        cwd: "relative/project",
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        resources: {},
        tools: [],
      }),
    ).rejects.toThrow("cwd must be an absolute path");
  });

  it("rejects a session when the controlled credential resolver has no key", async () => {
    const root = await tempDirectory();
    const adapter = new PiRuntimeAdapter({ agentDir: join(root, "agent"), resolveApiKey: async () => "" });

    await expect(
      adapter.startSession({
        runId: "run-5",
        roleRunId: "role-run-5",
        role: "executor",
        cwd: root,
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        resources: {},
        tools: [],
      }),
    ).rejects.toThrow("Controlled API key is not available");
  });
});
