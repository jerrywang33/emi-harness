import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { PiRuntimeSession } from "../src/pi-runtime-session.js";

function piSession(events: AgentSessionEvent[]): { session: AgentSession; dispose: ReturnType<typeof vi.fn> } {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const dispose = vi.fn();
  const session = {
    sessionId: "pi-session-1",
    subscribe: (next: (event: AgentSessionEvent) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    prompt: async () => {
      for (const event of events) {
        listener?.(event);
      }
    },
    abort: async () => undefined,
    dispose,
  } as unknown as AgentSession;
  return { session, dispose };
}

function completedEvents(): AgentSessionEvent[] {
  return [
    { type: "agent_start" },
    {
      type: "agent_end",
      messages: [fauxAssistantMessage("complete")],
      willRetry: false,
    },
    { type: "agent_settled" },
  ] as AgentSessionEvent[];
}

function runtimeSession(events = completedEvents()) {
  const fake = piSession(events);
  return {
    ...fake,
    runtime: new PiRuntimeSession(fake.session, ["gateway_probe"], {
      runId: "run-1",
      roleRunId: "role-run-1",
      role: "executor",
    }),
  };
}

describe("PiRuntimeSession", () => {
  it("returns the EMI-owned terminal result", async () => {
    const { runtime } = runtimeSession();

    await expect(runtime.run("execute")).resolves.toEqual({ outcome: "completed" });
  });

  it("reports observer failures only after delivering the settled event", async () => {
    const { runtime } = runtimeSession();
    const delivered: string[] = [];
    runtime.subscribe(async (event) => {
      delivered.push(event.type);
      if (event.type === "agent.started") {
        throw new Error("evidence write failed");
      }
    });

    await expect(runtime.run("execute")).rejects.toThrow("Runtime event delivery failed");
    expect(delivered).toEqual(["agent.started", "agent.ended", "agent.settled"]);
  });

  it("does not allow disposal while a run is active", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fake = piSession([]);
    fake.session.prompt = async () => pending;
    const runtime = new PiRuntimeSession(fake.session, [], {
      runId: "run-2",
      roleRunId: "role-run-2",
      role: "verifier",
    });

    const run = runtime.run("wait");
    expect(() => runtime.dispose()).toThrow("Cannot dispose a running session");
    finish?.();
    await expect(run).rejects.toThrow("without a terminal agent outcome");
    runtime.dispose();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });
});
