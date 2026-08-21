import type {
  JsonObject,
  PiRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeAgentOutcome,
  RuntimeRunResult,
  RuntimeSession,
  StartRuntimeSessionRequest,
} from "@emi-harness/runtime-pi";

export interface ScriptedToolCall {
  callId: string;
  name: string;
  input: JsonObject;
}

type RuntimeEventEnvelope = "role" | "roleRunId" | "runId" | "sessionId" | "source";
type ScriptedRuntimeEvent<T extends RuntimeEvent = RuntimeEvent> = T extends RuntimeEvent
  ? Omit<T, RuntimeEventEnvelope>
  : never;

class ScriptedSession implements RuntimeSession {
  readonly runId: string;
  readonly roleRunId: string;
  readonly role: StartRuntimeSessionRequest["role"];
  readonly sessionId: string;
  readonly activeToolNames: readonly string[];
  private readonly listeners = new Set<RuntimeEventListener>();
  private disposed = false;
  private aborted = false;

  constructor(
    private readonly request: StartRuntimeSessionRequest,
    private readonly calls: readonly ScriptedToolCall[],
    private readonly plannedOutcome: RuntimeAgentOutcome,
    sessionId: string,
  ) {
    this.runId = request.runId;
    this.roleRunId = request.roleRunId;
    this.role = request.role;
    this.sessionId = sessionId;
    this.activeToolNames = request.tools.map((tool) => tool.name);
  }

  async run(_prompt: string): Promise<RuntimeRunResult> {
    this.assertActive();
    await this.emit({ type: "agent.started", sourceType: "agent_start" });
    for (const call of this.calls) {
      if (this.aborted) break;
      const tool = this.request.tools.find((candidate) => candidate.name === call.name);
      if (tool === undefined) throw new Error(`Script requested unavailable tool: ${call.name}`);
      await this.emit({ type: "tool.started", sourceType: "tool_execution_start", callId: call.callId, toolName: call.name, input: call.input });
      const result = await tool.execute({ callId: call.callId, input: call.input, signal: undefined });
      await this.emit({
        type: "tool.completed",
        sourceType: "tool_execution_end",
        callId: call.callId,
        toolName: call.name,
        isError: result.isError ?? false,
      });
    }
    const outcome = this.aborted ? "aborted" : this.plannedOutcome;
    await this.emit({
      type: "agent.ended",
      sourceType: "agent_end",
      outcome,
      willRetry: false,
      ...(outcome === "completed" ? {} : { errorMessage: "Scripted Runtime did not complete" }),
    });
    await this.emit({ type: "agent.settled", sourceType: "agent_settled" });
    return { outcome };
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.assertActive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private async emit(event: ScriptedRuntimeEvent): Promise<void> {
    const full = {
      ...event,
      source: "pi" as const,
      runId: this.runId,
      roleRunId: this.roleRunId,
      role: this.role,
      sessionId: this.sessionId,
    } as RuntimeEvent;
    for (const listener of this.listeners) await listener(full);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Scripted Runtime Session is disposed");
  }
}

export class ScriptedRuntime implements PiRuntimePort {
  readonly starts: StartRuntimeSessionRequest[] = [];
  private readonly scripts = new Map<string, readonly ScriptedToolCall[]>();
  private readonly outcomes = new Map<string, RuntimeAgentOutcome>();
  private sessionNumber = 0;

  setScript(roleRunId: string, calls: readonly ScriptedToolCall[]): void {
    this.scripts.set(roleRunId, calls);
  }

  setOutcome(roleRunId: string, outcome: RuntimeAgentOutcome): void {
    this.outcomes.set(roleRunId, outcome);
  }

  async startSession(request: StartRuntimeSessionRequest): Promise<RuntimeSession> {
    this.starts.push(request);
    this.sessionNumber += 1;
    return new ScriptedSession(
      request,
      this.scripts.get(request.roleRunId) ?? [],
      this.outcomes.get(request.roleRunId) ?? "completed",
      `scripted-session-${this.sessionNumber}`,
    );
  }
}
