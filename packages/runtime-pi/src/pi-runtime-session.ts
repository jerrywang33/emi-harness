import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type {
  RuntimeEventContext,
  RuntimeEventListener,
  RuntimeRole,
  RuntimeRunResult,
  RuntimeSession,
} from "./contracts.js";
import { mapPiEvent } from "./pi-event-mapper.js";
import { RuntimeEventDispatcher } from "./runtime-event-dispatcher.js";

/** Internal Pi lifecycle wrapper; intentionally not exported from the package entrypoint. */
export class PiRuntimeSession implements RuntimeSession {
  readonly runId: string;
  readonly roleRunId: string;
  readonly role: RuntimeRole;
  readonly sessionId: string;
  readonly activeToolNames: readonly string[];

  private readonly events = new RuntimeEventDispatcher();
  private readonly unsubscribePi: () => void;
  private disposed = false;
  private running = false;
  private runResult: RuntimeRunResult | undefined;

  constructor(
    private readonly session: AgentSession,
    toolNames: readonly string[],
    context: Omit<RuntimeEventContext, "sessionId">,
  ) {
    this.runId = context.runId;
    this.roleRunId = context.roleRunId;
    this.role = context.role;
    this.sessionId = session.sessionId;
    this.activeToolNames = Object.freeze([...toolNames]);
    const eventContext: RuntimeEventContext = { ...context, sessionId: this.sessionId };
    this.unsubscribePi = session.subscribe((event) => {
      const mapped = mapPiEvent(event, eventContext);
      if (mapped.type === "agent.ended" && !mapped.willRetry) {
        this.runResult = {
          outcome: mapped.outcome,
          ...(mapped.errorMessage === undefined ? {} : { errorMessage: mapped.errorMessage }),
        };
      }
      this.events.publish(mapped);
    });
  }

  async run(prompt: string): Promise<RuntimeRunResult> {
    this.assertActive();
    if (this.running) {
      throw new Error("Runtime session is already running");
    }
    this.running = true;
    this.runResult = undefined;

    try {
      let runtimeError: unknown;
      let failed = false;
      try {
        await this.session.prompt(prompt, { expandPromptTemplates: false });
      } catch (error) {
        runtimeError = error;
        failed = true;
      }

      const listenerErrors = await this.events.settle();
      if (failed && listenerErrors.length > 0) {
        throw new AggregateError([runtimeError, ...listenerErrors], "Pi runtime and event delivery failed");
      }
      if (failed) {
        throw runtimeError;
      }
      if (listenerErrors.length > 0) {
        throw new AggregateError(listenerErrors, "Runtime event delivery failed");
      }
      if (this.runResult === undefined) {
        throw new Error("Pi runtime settled without a terminal agent outcome");
      }
      return this.runResult;
    } finally {
      this.running = false;
    }
  }

  async abort(): Promise<void> {
    this.assertActive();
    await this.session.abort();
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.assertActive();
    return this.events.subscribe(listener);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    if (this.running) {
      throw new Error("Cannot dispose a running session; abort and await run() first");
    }
    this.disposed = true;
    this.unsubscribePi();
    this.events.clear();
    this.session.dispose();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Runtime session has been disposed");
    }
  }
}
