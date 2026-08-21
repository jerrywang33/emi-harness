import { isAbsolute } from "node:path";

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type {
  JsonObject,
  PiRuntimePort,
  RuntimeRunResult,
  RuntimeSession,
  StartRuntimeSessionRequest,
} from "../contracts.js";
import { createControlledPiRuntimeSession } from "../controlled-pi-session-factory.js";

export const DETERMINISTIC_PI_MODEL = Object.freeze({
  provider: "emi-harness-faux",
  id: "deterministic-v0.1",
});

export type DeterministicPiResponse =
  | { type: "text"; text: string }
  | { type: "tool_call"; callId: string; toolName: string; input: JsonObject };

export interface DeterministicPiScript {
  roleRunId: string;
  responses: readonly DeterministicPiResponse[];
}

export interface DeterministicPiRuntimeAdapterConfig {
  agentDir: string;
  scripts: readonly DeterministicPiScript[];
}

export interface DeterministicPiStartObservation {
  runId: string;
  roleRunId: string;
  role: StartRuntimeSessionRequest["role"];
  sessionId: string;
  toolNames: readonly string[];
  resourceSources: readonly string[];
}

class FixedCredentials implements CredentialStore {
  async read(): Promise<Credential> {
    return { type: "api_key", key: "deterministic-local-only-key" };
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [];
  }

  async modify(): Promise<Credential | undefined> {
    throw new Error("Deterministic Runtime credentials are read-only");
  }

  async delete(): Promise<void> {
    throw new Error("Deterministic Runtime credentials are read-only");
  }
}

function validateScripts(scripts: readonly DeterministicPiScript[]): Map<string, readonly DeterministicPiResponse[]> {
  if (scripts.length === 0) throw new Error("Deterministic Pi Runtime requires at least one RoleRun script");
  const result = new Map<string, readonly DeterministicPiResponse[]>();
  for (const script of scripts) {
    if (script.roleRunId.trim().length === 0 || result.has(script.roleRunId) || script.responses.length === 0) {
      throw new Error(`Invalid or duplicate deterministic RoleRun script: ${script.roleRunId}`);
    }
    for (const response of script.responses) {
      if (response.type === "text") {
        if (response.text.trim().length === 0) throw new Error("Deterministic text response must not be empty");
      } else if (
        response.callId.trim().length === 0 ||
        !/^[a-z][a-z0-9_.-]{0,63}$/u.test(response.toolName)
      ) {
        throw new Error(`Invalid deterministic tool response: ${response.toolName}`);
      }
    }
    result.set(script.roleRunId, Object.freeze(structuredClone(script.responses)));
  }
  return result;
}

class DeterministicRuntimeSession implements RuntimeSession {
  readonly runId: string;
  readonly roleRunId: string;
  readonly role: RuntimeSession["role"];
  readonly sessionId: string;
  readonly activeToolNames: readonly string[];
  private disposed = false;

  constructor(
    private readonly delegate: RuntimeSession,
    private readonly pendingResponses: () => number,
    private readonly release: () => void,
  ) {
    this.runId = delegate.runId;
    this.roleRunId = delegate.roleRunId;
    this.role = delegate.role;
    this.sessionId = delegate.sessionId;
    this.activeToolNames = delegate.activeToolNames;
  }

  async run(prompt: string): Promise<RuntimeRunResult> {
    const result = await this.delegate.run(prompt);
    const pending = this.pendingResponses();
    if (pending !== 0) throw new Error(`Deterministic Pi script has ${pending} unconsumed response(s)`);
    return result;
  }

  abort(): Promise<void> {
    return this.delegate.abort();
  }

  subscribe(listener: Parameters<RuntimeSession["subscribe"]>[0]): () => void {
    return this.delegate.subscribe(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.delegate.dispose();
    this.disposed = true;
    this.release();
  }
}

export class DeterministicPiRuntimeAdapter implements PiRuntimePort {
  private readonly usedRoleRunIds = new Set<string>();
  private readonly startObservations: DeterministicPiStartObservation[] = [];
  private active = false;
  private disposed = false;

  private constructor(
    private readonly agentDir: string,
    private readonly scripts: Map<string, readonly DeterministicPiResponse[]>,
    private readonly faux: ReturnType<typeof registerFauxProvider>,
    private readonly modelRuntime: ModelRuntime,
  ) {}

  static async create(config: DeterministicPiRuntimeAdapterConfig): Promise<DeterministicPiRuntimeAdapter> {
    if (!isAbsolute(config.agentDir)) throw new Error("Deterministic Pi agentDir must be absolute");
    const scripts = validateScripts(config.scripts);
    const faux = registerFauxProvider({
      api: "emi-harness-faux-api-v1",
      provider: DETERMINISTIC_PI_MODEL.provider,
      models: [{ id: DETERMINISTIC_PI_MODEL.id, name: "EMI Harness deterministic calibration model" }],
    });
    const model = faux.getModel();
    const modelRuntime = await ModelRuntime.create({
      credentials: new FixedCredentials(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(model.provider, {
      api: model.api,
      baseUrl: model.baseUrl,
      models: [{
        id: model.id,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }],
    });
    return new DeterministicPiRuntimeAdapter(config.agentDir, scripts, faux, modelRuntime);
  }

  async startSession(request: StartRuntimeSessionRequest): Promise<RuntimeSession> {
    if (this.disposed) throw new Error("Deterministic Pi Runtime is disposed");
    if (this.active) throw new Error("Deterministic Pi Runtime permits only one active Session");
    if (
      request.model.provider !== DETERMINISTIC_PI_MODEL.provider ||
      request.model.id !== DETERMINISTIC_PI_MODEL.id
    ) {
      throw new Error(`Deterministic model must be ${DETERMINISTIC_PI_MODEL.provider}/${DETERMINISTIC_PI_MODEL.id}`);
    }
    const responses = this.scripts.get(request.roleRunId);
    if (responses === undefined || this.usedRoleRunIds.has(request.roleRunId)) {
      throw new Error(`No unused deterministic script exists for RoleRun: ${request.roleRunId}`);
    }
    if (this.faux.getPendingResponseCount() !== 0) {
      throw new Error("Previous deterministic Pi script was not fully consumed");
    }
    this.faux.setResponses(responses.map((response) => response.type === "text"
      ? fauxAssistantMessage(response.text)
      : fauxAssistantMessage(
          fauxToolCall(response.toolName, response.input, { id: response.callId }),
          { stopReason: "toolUse" },
        )));
    this.active = true;
    this.usedRoleRunIds.add(request.roleRunId);
    try {
      const session = await createControlledPiRuntimeSession({
        agentDir: this.agentDir,
        modelRuntime: this.modelRuntime,
        request,
      });
      this.startObservations.push(Object.freeze({
        runId: request.runId,
        roleRunId: request.roleRunId,
        role: request.role,
        sessionId: session.sessionId,
        toolNames: Object.freeze([...session.activeToolNames]),
        resourceSources: Object.freeze([
          ...(request.resources.systemPrompt === undefined ? [] : [request.resources.systemPrompt.source]),
          ...(request.resources.appendSystemPrompts ?? []).map((resource) => resource.source),
          ...(request.resources.contextFiles ?? []).map((resource) => resource.source),
        ]),
      }));
      return new DeterministicRuntimeSession(session, () => this.faux.getPendingResponseCount(), () => {
        this.active = false;
      });
    } catch (error) {
      this.active = false;
      this.faux.setResponses([]);
      throw error;
    }
  }

  usedScripts(): readonly string[] {
    return [...this.usedRoleRunIds].sort();
  }

  starts(): readonly DeterministicPiStartObservation[] {
    return structuredClone(this.startObservations);
  }

  dispose(): void {
    if (this.active) throw new Error("Cannot dispose Deterministic Pi Runtime with an active Session");
    if (this.disposed) return;
    this.disposed = true;
    this.modelRuntime.unregisterProvider(DETERMINISTIC_PI_MODEL.provider);
    this.faux.unregister();
  }
}
