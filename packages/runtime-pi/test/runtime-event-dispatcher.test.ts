import { describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../src/contracts.js";
import { RuntimeEventDispatcher } from "../src/runtime-event-dispatcher.js";

const event: RuntimeEvent = {
  type: "agent.started",
  source: "pi",
  sourceType: "agent_start",
  runId: "run-1",
  roleRunId: "role-run-1",
  role: "executor",
  sessionId: "session-1",
};

describe("RuntimeEventDispatcher", () => {
  it("delivers events in order and records synchronous or asynchronous observer failures", async () => {
    const dispatcher = new RuntimeEventDispatcher();
    const observer = vi.fn();
    dispatcher.subscribe(() => {
      throw new Error("evidence sink unavailable");
    });
    dispatcher.subscribe(async (published) => {
      await Promise.resolve();
      observer(published);
    });

    dispatcher.publish(event);
    dispatcher.publish({ ...event, type: "agent.settled", sourceType: "agent_settled" });

    await expect(dispatcher.settle()).resolves.toEqual([
      expect.objectContaining({ message: "evidence sink unavailable" }),
      expect.objectContaining({ message: "evidence sink unavailable" }),
    ]);
    expect(observer.mock.calls.map(([published]) => published.type)).toEqual(["agent.started", "agent.settled"]);
    await expect(dispatcher.settle()).resolves.toEqual([]);
  });
});
