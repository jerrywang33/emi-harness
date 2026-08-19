import { isAbsolute } from "node:path";

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type {
  JsonObject,
  PiRuntimePort,
  RuntimeSession,
  RuntimeTool,
  StartRuntimeSessionRequest,
} from "./contracts.js";
import { ControlledResourceLoader } from "./controlled-resource-loader.js";
import { PiRuntimeSession } from "./pi-runtime-session.js";

const RESERVED_PI_TOOLS = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

export interface PiRuntimeAdapterConfig {
  agentDir: string;
  resolveApiKey(provider: string): Promise<string> | string;
}

class ControlledCredentialStore implements CredentialStore {
  constructor(private readonly resolveApiKey: PiRuntimeAdapterConfig["resolveApiKey"]) {}

  async read(providerId: string): Promise<Credential> {
    const key = await this.resolveApiKey(providerId);
    if (key.trim().length === 0) {
      throw new Error(`Controlled API key is not available for provider: ${providerId}`);
    }
    return { type: "api_key", key };
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [];
  }

  async modify(): Promise<Credential | undefined> {
    throw new Error("Runtime credentials are read-only");
  }

  async delete(): Promise<void> {
    throw new Error("Runtime credentials are read-only");
  }
}

function validateTools(tools: readonly RuntimeTool[]): void {
  const names = new Set<string>();

  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(`Invalid runtime tool name: ${tool.name}`);
    }
    if (RESERVED_PI_TOOLS.has(tool.name)) {
      throw new Error(`Pi built-in tool is not allowed in controlled runtime: ${tool.name}`);
    }
    if (names.has(tool.name)) {
      throw new Error(`Duplicate runtime tool name: ${tool.name}`);
    }
    if (tool.inputSchema.type !== "object") {
      throw new Error(`Runtime tool input schema must describe an object: ${tool.name}`);
    }
    names.add(tool.name);
  }
}

function requireValue(label: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function validateRequest(request: StartRuntimeSessionRequest): void {
  requireValue("runId", request.runId);
  requireValue("roleRunId", request.roleRunId);
  requireValue("model provider", request.model.provider);
  requireValue("model id", request.model.id);
  requireValue("cwd", request.cwd);
  if (!isAbsolute(request.cwd)) {
    throw new Error("Runtime cwd must be an absolute path");
  }
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

function sameToolNames(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length && expected.every((name, index) => name === actual[index]);
}

export class PiRuntimeAdapter implements PiRuntimePort {
  private modelRuntimePromise: Promise<ModelRuntime> | undefined;

  constructor(private readonly config: PiRuntimeAdapterConfig) {
    requireValue("Pi agentDir", config.agentDir);
    if (!isAbsolute(config.agentDir)) {
      throw new Error("Pi agentDir must be an absolute path");
    }
  }

  async startSession(request: StartRuntimeSessionRequest): Promise<RuntimeSession> {
    validateRequest(request);

    const modelRuntime = await this.getModelRuntime();
    const model = modelRuntime.getModel(request.model.provider, request.model.id);
    if (!model) {
      throw new Error(`Pi model is not available: ${request.model.provider}/${request.model.id}`);
    }
    await modelRuntime.checkAuth(request.model.provider);

    const toolNames = request.tools.map((tool) => tool.name);
    const resourceLoader = new ControlledResourceLoader(request.resources);
    const customTools = request.tools.map(toPiTool);
    const settingsManager = SettingsManager.inMemory({ defaultTools: [] });
    const sessionManager = SessionManager.inMemory(request.cwd);
    const { session } = await createAgentSession({
      cwd: request.cwd,
      agentDir: this.config.agentDir,
      model,
      modelRuntime,
      settingsManager,
      sessionManager,
      resourceLoader,
      tools: toolNames,
      noTools: "all",
      customTools,
      ...(request.model.thinkingLevel === undefined ? {} : { thinkingLevel: request.model.thinkingLevel }),
    });

    const activeToolNames = session.getActiveToolNames();
    if (!sameToolNames(toolNames, activeToolNames)) {
      session.dispose();
      throw new Error(
        `Pi active tool contract mismatch: expected [${toolNames.join(", ")}], received [${activeToolNames.join(", ")}]`,
      );
    }

    return new PiRuntimeSession(session, activeToolNames, {
      runId: request.runId,
      roleRunId: request.roleRunId,
      role: request.role,
    });
  }

  private getModelRuntime(): Promise<ModelRuntime> {
    this.modelRuntimePromise ??= ModelRuntime.create({
      credentials: new ControlledCredentialStore(this.config.resolveApiKey),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    return this.modelRuntimePromise;
  }
}
