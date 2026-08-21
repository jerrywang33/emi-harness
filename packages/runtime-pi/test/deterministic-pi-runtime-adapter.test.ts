import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeTool } from "../src/contracts.js";
import {
  DETERMINISTIC_PI_MODEL,
  DeterministicPiRuntimeAdapter,
} from "../src/testing/deterministic-pi-runtime-adapter.js";

describe("DeterministicPiRuntimeAdapter", () => {
  it("uses a real controlled Pi Session and consumes each RoleRun script once", async () => {
    const root = await mkdtemp(join(tmpdir(), "emi-deterministic-pi-"));
    const calls: unknown[] = [];
    const tool: RuntimeTool = {
      name: "gateway_probe",
      description: "Probe the controlled tool bridge",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      execute: async ({ input }) => {
        calls.push(input);
        return { text: "accepted" };
      },
    };
    const runtime = await DeterministicPiRuntimeAdapter.create({
      agentDir: join(root, "agent"),
      scripts: [{
        roleRunId: "role-run-1",
        responses: [
          { type: "tool_call", callId: "probe-1", toolName: "gateway_probe", input: { value: "controlled" } },
          { type: "text", text: "complete" },
        ],
      }],
    });
    try {
      const session = await runtime.startSession({
        runId: "run-1",
        roleRunId: "role-run-1",
        role: "executor",
        cwd: root,
        model: DETERMINISTIC_PI_MODEL,
        resources: { systemPrompt: { source: "emi:test", content: "Controlled only" } },
        tools: [tool],
      });
      expect(session.sessionId).not.toBe("");
      expect(session.activeToolNames).toEqual(["gateway_probe"]);
      await expect(session.run("Call the probe")).resolves.toEqual({ outcome: "completed" });
      expect(calls).toEqual([{ value: "controlled" }]);
      session.dispose();
      await expect(runtime.startSession({
        runId: "run-1",
        roleRunId: "role-run-1",
        role: "executor",
        cwd: root,
        model: DETERMINISTIC_PI_MODEL,
        resources: {},
        tools: [tool],
      })).rejects.toThrow("No unused deterministic script");
      expect(runtime.usedScripts()).toEqual(["role-run-1"]);
    } finally {
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
