export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonObject {
  [key: string]: JsonValue;
}

export type RuntimeRole = "coordinator" | "executor" | "verifier";

export type RuntimeThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeModelRef {
  provider: string;
  id: string;
  thinkingLevel?: RuntimeThinkingLevel;
}

export interface RuntimeTextResource {
  source: string;
  content: string;
}

export interface RuntimeResourceSnapshot {
  systemPrompt?: RuntimeTextResource;
  appendSystemPrompts?: readonly RuntimeTextResource[];
  contextFiles?: readonly RuntimeTextResource[];
}

export interface RuntimeToolCall {
  callId: string;
  input: JsonObject;
  signal: AbortSignal | undefined;
}

export interface RuntimeToolResult {
  text: string;
  isError?: boolean;
  details?: JsonValue;
}

export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  execute(call: RuntimeToolCall): Promise<RuntimeToolResult>;
}

export interface StartRuntimeSessionRequest {
  runId: string;
  roleRunId: string;
  role: RuntimeRole;
  cwd: string;
  model: RuntimeModelRef;
  resources: RuntimeResourceSnapshot;
  tools: readonly RuntimeTool[];
}

export type RuntimeMessageRole = "assistant" | "custom" | "tool" | "unknown" | "user";

export type RuntimeAgentOutcome = "aborted" | "completed" | "error" | "incomplete" | "unknown";

export interface RuntimeRunResult {
  outcome: RuntimeAgentOutcome;
  errorMessage?: string;
}

export interface RuntimeEventContext {
  runId: string;
  roleRunId: string;
  role: RuntimeRole;
  sessionId: string;
}

interface RuntimeEventSource {
  source: "pi";
  sourceType: string;
  runId: string;
  roleRunId: string;
  role: RuntimeRole;
  sessionId: string;
}

export type RuntimeEvent = RuntimeEventSource &
  (
    | { type: "agent.started" }
    | {
        type: "agent.ended";
        outcome: RuntimeAgentOutcome;
        willRetry: boolean;
        errorMessage?: string;
      }
    | { type: "agent.settled" }
    | { type: "turn.started" }
    | { type: "turn.completed" }
    | { type: "message.started"; messageRole: RuntimeMessageRole }
    | { type: "message.updated"; messageRole: RuntimeMessageRole }
    | { type: "message.completed"; messageRole: RuntimeMessageRole }
    | { type: "tool.started"; callId: string; toolName: string; input: JsonValue }
    | { type: "tool.updated"; callId: string; toolName: string }
    | { type: "tool.completed"; callId: string; toolName: string; isError: boolean }
    | { type: "retry.started"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
    | { type: "retry.completed"; attempt: number; success: boolean; finalError?: string }
    | {
        type: "compaction.started";
        reason: "manual" | "overflow" | "threshold";
      }
    | {
        type: "compaction.completed";
        reason: "manual" | "overflow" | "threshold";
        aborted: boolean;
        willRetry: boolean;
        errorMessage?: string;
      }
    | { type: "runtime.observed" }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => Promise<void> | void;

export interface RuntimeSession {
  readonly runId: string;
  readonly roleRunId: string;
  readonly role: RuntimeRole;
  readonly sessionId: string;
  readonly activeToolNames: readonly string[];
  run(prompt: string): Promise<RuntimeRunResult>;
  abort(): Promise<void>;
  subscribe(listener: RuntimeEventListener): () => void;
  dispose(): void;
}

export interface PiRuntimePort {
  startSession(request: StartRuntimeSessionRequest): Promise<RuntimeSession>;
}
