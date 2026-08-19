import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type {
  JsonValue,
  RuntimeAgentOutcome,
  RuntimeEvent,
  RuntimeEventContext,
  RuntimeMessageRole,
} from "./contracts.js";

function messageRole(role: string): RuntimeMessageRole {
  if (role === "user" || role === "assistant" || role === "custom") {
    return role;
  }
  if (role === "toolResult") {
    return "tool";
  }
  return "unknown";
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => (entry === undefined ? [] : [[key, jsonValue(entry)]])),
    );
  }
  return String(value);
}

function agentOutcome(event: Extract<AgentSessionEvent, { type: "agent_end" }>): {
  outcome: RuntimeAgentOutcome;
  errorMessage?: string;
} {
  const message = event.messages.findLast((candidate) => candidate.role === "assistant");
  if (message?.role !== "assistant") {
    return { outcome: "unknown" };
  }

  switch (message.stopReason) {
    case "stop":
      return { outcome: "completed" };
    case "aborted":
      return {
        outcome: "aborted",
        ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
      };
    case "error":
      return {
        outcome: "error",
        ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
      };
    case "deferred":
    case "length":
    case "pending":
    case "toolUse":
      return { outcome: "incomplete" };
  }
}

export function mapPiEvent(event: AgentSessionEvent, context: RuntimeEventContext): RuntimeEvent {
  const source = { source: "pi" as const, sourceType: event.type, ...context };

  switch (event.type) {
    case "agent_start":
      return { ...source, type: "agent.started" };
    case "agent_end":
      return { ...source, type: "agent.ended", willRetry: event.willRetry, ...agentOutcome(event) };
    case "agent_settled":
      return { ...source, type: "agent.settled" };
    case "turn_start":
      return { ...source, type: "turn.started" };
    case "turn_end":
      return { ...source, type: "turn.completed" };
    case "message_start":
      return { ...source, type: "message.started", messageRole: messageRole(event.message.role) };
    case "message_update":
      return { ...source, type: "message.updated", messageRole: messageRole(event.message.role) };
    case "message_end":
      return { ...source, type: "message.completed", messageRole: messageRole(event.message.role) };
    case "tool_execution_start":
      return {
        ...source,
        type: "tool.started",
        callId: event.toolCallId,
        toolName: event.toolName,
        input: jsonValue(event.args),
      };
    case "tool_execution_update":
      return { ...source, type: "tool.updated", callId: event.toolCallId, toolName: event.toolName };
    case "tool_execution_end":
      return {
        ...source,
        type: "tool.completed",
        callId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "auto_retry_start":
      return {
        ...source,
        type: "retry.started",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      };
    case "auto_retry_end":
      return {
        ...source,
        type: "retry.completed",
        attempt: event.attempt,
        success: event.success,
        ...(event.finalError === undefined ? {} : { finalError: event.finalError }),
      };
    case "compaction_start":
      return { ...source, type: "compaction.started", reason: event.reason };
    case "compaction_end":
      return {
        ...source,
        type: "compaction.completed",
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
      };
    default:
      return { ...source, type: "runtime.observed" };
  }
}
