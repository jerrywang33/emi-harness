import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  type AgentSessionEvent,
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { ControlledResourceLoader } from "../src/controlled-resource-loader.js";
import { mapPiEvent } from "../src/pi-event-mapper.js";

class MemoryCredentials implements CredentialStore {
  private readonly values = new Map<string, Credential>();

  async read(providerId: string): Promise<Credential | undefined> {
    return this.values.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Array.from(this.values, ([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  async modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await update(this.values.get(providerId));
    if (next !== undefined) {
      this.values.set(providerId, next);
    }
    return this.values.get(providerId);
  }

  async delete(providerId: string): Promise<void> {
    this.values.delete(providerId);
  }
}

const directories: string[] = [];

async function createFauxRuntime(options?: Parameters<typeof registerFauxProvider>[0]) {
  const faux = registerFauxProvider(options);
  const model = faux.getModel();
  const credentials = new MemoryCredentials();
  await credentials.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerProvider(model.provider, {
    api: model.api,
    baseUrl: model.baseUrl,
    models: [
      {
        id: model.id,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
  });
  return { faux, model, modelRuntime };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Pi 0.84.2 controlled embedding contract", () => {
  it("runs without network using only controlled resources and an exact custom tool allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "emi-pi-contract-"));
    directories.push(root);
    await writeFile(join(root, "AGENTS.md"), "AMBIENT_CONTEXT_MUST_NOT_LOAD", "utf8");

    const { faux, model, modelRuntime } = await createFauxRuntime();

    const calls: unknown[] = [];
    const tool: ToolDefinition = {
      name: "gateway_probe",
      label: "Gateway Probe",
      description: "Controlled gateway probe",
      parameters: Type.Object({ value: Type.String() }),
      execute: async (_callId, params) => {
        calls.push(params);
        return { content: [{ type: "text", text: "gateway-ok" }], details: {} };
      },
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("gateway_probe", { value: "approved" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("complete"),
    ]);

    const resourceLoader = new ControlledResourceLoader({
      systemPrompt: { source: "emi://prompt/system", content: "CONTROLLED_SYSTEM_PROMPT" },
      contextFiles: [{ source: "emi://context/approved", content: "APPROVED_CONTEXT" }],
    });
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      model,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({ defaultTools: ["bash"] }),
      sessionManager: SessionManager.inMemory(root),
      resourceLoader,
      tools: ["gateway_probe"],
      noTools: "all",
      customTools: [tool],
    });
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => events.push(event));

    try {
      expect(session.getActiveToolNames()).toEqual(["gateway_probe"]);
      expect(session.getAllTools().map((entry) => entry.name)).toEqual(["gateway_probe"]);
      expect(session.systemPrompt).toContain("CONTROLLED_SYSTEM_PROMPT");
      expect(session.systemPrompt).toContain("APPROVED_CONTEXT");
      expect(session.systemPrompt).not.toContain("AMBIENT_CONTEXT_MUST_NOT_LOAD");

      await session.prompt("run the controlled probe", { expandPromptTemplates: false });

      expect(calls).toEqual([{ value: "approved" }]);
      const mapped = events.map((event) =>
        mapPiEvent(event, {
          runId: "run-contract",
          roleRunId: "role-run-contract",
          role: "executor",
          sessionId: session.sessionId,
        }),
      );
      expect(mapped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "agent.started",
            sourceType: "agent_start",
            runId: "run-contract",
            roleRunId: "role-run-contract",
            role: "executor",
            sessionId: session.sessionId,
          }),
          expect.objectContaining({
            type: "tool.started",
            sourceType: "tool_execution_start",
            toolName: "gateway_probe",
          }),
          expect.objectContaining({
            type: "tool.completed",
            sourceType: "tool_execution_end",
            toolName: "gateway_probe",
            isError: false,
          }),
          expect.objectContaining({
            type: "agent.ended",
            sourceType: "agent_end",
            outcome: "completed",
            willRetry: false,
          }),
          expect.objectContaining({ type: "agent.settled", sourceType: "agent_settled" }),
        ]),
      );
      expect(faux.getPendingResponseCount()).toBe(0);
    } finally {
      session.dispose();
      modelRuntime.unregisterProvider(model.provider);
      faux.unregister();
    }
  });

  it("aborts an active request and settles with an explicit aborted outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "emi-pi-abort-contract-"));
    directories.push(root);
    const { faux, model, modelRuntime } = await createFauxRuntime({
      tokensPerSecond: 10,
      tokenSize: { min: 1, max: 1 },
    });
    faux.setResponses([fauxAssistantMessage("streaming response that must be interrupted")]);

    const { session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      model,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({ defaultTools: ["bash"] }),
      sessionManager: SessionManager.inMemory(root),
      resourceLoader: new ControlledResourceLoader({}),
      tools: [],
      noTools: "all",
      customTools: [],
    });
    const events: AgentSessionEvent[] = [];
    let markAssistantStarted: (() => void) | undefined;
    const assistantStarted = new Promise<void>((resolve) => {
      markAssistantStarted = resolve;
    });
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "message_start" && event.message.role === "assistant") {
        markAssistantStarted?.();
      }
    });

    try {
      const run = session.prompt("start a response", { expandPromptTemplates: false });
      await assistantStarted;
      await session.abort();
      await run;

      expect(session.isIdle).toBe(true);
      const mapped = events.map((event) =>
        mapPiEvent(event, {
          runId: "run-abort-contract",
          roleRunId: "role-run-abort-contract",
          role: "executor",
          sessionId: session.sessionId,
        }),
      );
      expect(mapped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "agent.ended",
            sourceType: "agent_end",
            outcome: "aborted",
            willRetry: false,
          }),
          expect.objectContaining({ type: "agent.settled", sourceType: "agent_settled" }),
        ]),
      );
      expect(mapped.findIndex((event) => event.type === "agent.ended")).toBeLessThan(
        mapped.findIndex((event) => event.type === "agent.settled"),
      );
    } finally {
      session.dispose();
      modelRuntime.unregisterProvider(model.provider);
      faux.unregister();
    }
  });
});
