import { isAbsolute } from "node:path";

import {
  createAgentSession,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type {
  JsonObject,
  RuntimeSession,
  RuntimeTool,
  StartRuntimeSessionRequest,
} from "./contracts.js";
import { ControlledResourceLoader } from "./controlled-resource-loader.js";
import { PiRuntimeSession } from "./pi-runtime-session.js";

const RESERVED_PI_TOOLS = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

function requireValue(label: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function validateTools(tools: readonly RuntimeTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`Invalid runtime tool name: ${tool.name}`);
    if (RESERVED_PI_TOOLS.has(tool.name)) {
      throw new Error(`Pi built-in tool is not allowed in controlled runtime: ${tool.name}`);
    }
    if (names.has(tool.name)) throw new Error(`Duplicate runtime tool name: ${tool.name}`);
    if (tool.inputSchema.type !== "object") {
      throw new Error(`Runtime tool input schema must describe an object: ${tool.name}`);
    }
    names.add(tool.name);
  }
}

function validateRequest(request: StartRuntimeSessionRequest): void {
  requireValue("runId", request.runId);
  requireValue("roleRunId", request.roleRunId);
  requireValue("model provider", request.model.provider);
  requireValue("model id", request.model.id);
  requireValue("cwd", request.cwd);
  if (!isAbsolute(request.cwd)) throw new Error("Runtime cwd must be an absolute path");
  validateTools(request.tools);
}

function toPiTool(tool: RuntimeTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as ToolDefinition["parameters"],
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const result = await tool.execute({
        callId: toolCallId,
        input: params as JsonObject,
        signal,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details ?? {},
        isError: result.isError ?? false,
      };
    },
  };
}

export async function createControlledPiRuntimeSession(input: {
  agentDir: string;
  modelRuntime: ModelRuntime;
  request: StartRuntimeSessionRequest;
}): Promise<RuntimeSession> {
  validateRequest(input.request);
  const model = input.modelRuntime.getModel(input.request.model.provider, input.request.model.id);
  if (!model) {
    throw new Error(`Pi model is not available: ${input.request.model.provider}/${input.request.model.id}`);
  }
  await input.modelRuntime.checkAuth(input.request.model.provider);

  const toolNames = input.request.tools.map((tool) => tool.name);
  const { session } = await createAgentSession({
    cwd: input.request.cwd,
    agentDir: input.agentDir,
    model,
    modelRuntime: input.modelRuntime,
    settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
    sessionManager: SessionManager.inMemory(input.request.cwd),
    resourceLoader: new ControlledResourceLoader(input.request.resources),
    tools: toolNames,
    noTools: "all",
    customTools: input.request.tools.map(toPiTool),
    ...(input.request.model.thinkingLevel === undefined ? {} : { thinkingLevel: input.request.model.thinkingLevel }),
  });

  const activeToolNames = session.getActiveToolNames();
  if (
    toolNames.length !== activeToolNames.length ||
    !toolNames.every((name, index) => name === activeToolNames[index])
  ) {
    session.dispose();
    throw new Error(
      `Pi active tool contract mismatch: expected [${toolNames.join(", ")}], received [${activeToolNames.join(", ")}]`,
    );
  }

  return new PiRuntimeSession(session, activeToolNames, {
    runId: input.request.runId,
    roleRunId: input.request.roleRunId,
    role: input.request.role,
  });
}
