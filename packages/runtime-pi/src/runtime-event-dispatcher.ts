import type { RuntimeEvent, RuntimeEventListener } from "./contracts.js";

/** Keeps observer failures from interrupting Pi while preserving them for the run caller. */
export class RuntimeEventDispatcher {
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly errors: unknown[] = [];
  private delivery = Promise.resolve();
  private closed = false;

  publish(event: RuntimeEvent): void {
    const listeners = [...this.listeners];
    this.delivery = this.delivery.then(async () => {
      if (this.closed) {
        return;
      }
      for (const listener of listeners) {
        try {
          await listener(event);
        } catch (error) {
          this.errors.push(error);
        }
      }
    });
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async settle(): Promise<unknown[]> {
    await this.delivery;
    return this.errors.splice(0);
  }

  clear(): void {
    this.closed = true;
    this.listeners.clear();
    this.errors.length = 0;
  }
}
