import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fail } from "./errors.js";
import type {
  IsolatedExecutionResult,
  IsolatedToolExecutorPort,
  JsonObject,
  OperationIntent,
  ReconciliationResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface SubprocessWorkspaceExecutorConfig {
  repositoryId: string;
  workspaceRoot: string;
  workerPath?: string;
  timeoutMs?: number;
}

interface WorkerResponse {
  protocolVersion: "1";
  action: "execute" | "reconcile";
  outcome: string;
  output: JsonObject;
  evidenceRefs: readonly string[];
  errorCode?: string;
  sanitizedError?: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseResponse(raw: string, action: WorkerResponse["action"]): WorkerResponse {
  const parsed = object(JSON.parse(raw), "Worker response");
  const allowed = new Set(["protocolVersion", "action", "outcome", "output", "evidenceRefs", "errorCode", "sanitizedError"]);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) {
    throw new Error("Worker response contains unknown fields");
  }
  if (parsed.protocolVersion !== "1" || parsed.action !== action || typeof parsed.outcome !== "string") {
    throw new Error("Worker response does not match the requested protocol");
  }
  const output = object(parsed.output, "Worker output") as JsonObject;
  if (!Array.isArray(parsed.evidenceRefs) || parsed.evidenceRefs.some((item) => typeof item !== "string")) {
    throw new Error("Worker evidenceRefs must be strings");
  }
  const errorCode = parsed.errorCode;
  const sanitizedError = parsed.sanitizedError;
  if ((errorCode === undefined) !== (sanitizedError === undefined)) {
    throw new Error("Worker error fields must appear together");
  }
  if (errorCode !== undefined && (typeof errorCode !== "string" || typeof sanitizedError !== "string")) {
    throw new Error("Worker error fields must be strings");
  }
  return {
    protocolVersion: "1",
    action,
    outcome: parsed.outcome,
    output,
    evidenceRefs: parsed.evidenceRefs as string[],
    ...(errorCode === undefined ? {} : { errorCode, sanitizedError: sanitizedError as string }),
  };
}

export class SubprocessWorkspaceExecutor implements IsolatedToolExecutorPort {
  private constructor(
    private readonly repositoryId: string,
    private readonly workspaceRoot: string,
    private readonly workerPath: string,
    private readonly timeoutMs: number,
  ) {}

  static async create(config: SubprocessWorkspaceExecutorConfig): Promise<SubprocessWorkspaceExecutor> {
    if (config.repositoryId.trim().length === 0) {
      fail("invalid_input", "repositoryId must not be empty");
    }
    if (!isAbsolute(config.workspaceRoot)) {
      fail("invalid_input", "workspaceRoot must be absolute");
    }
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      fail("invalid_input", "timeoutMs must be between 1 and 60000");
    }
    const workspaceRoot = await realpath(config.workspaceRoot);
    const defaultWorker = resolve(dirname(fileURLToPath(import.meta.url)), "../worker/workspace-worker.mjs");
    const workerPath = await realpath(config.workerPath ?? defaultWorker);
    return new SubprocessWorkspaceExecutor(config.repositoryId, workspaceRoot, workerPath, timeoutMs);
  }

  async execute(intent: OperationIntent, signal?: AbortSignal): Promise<IsolatedExecutionResult> {
    this.assertRepository(intent);
    const response = await this.callWorker("execute", intent, signal);
    if (response.outcome !== "succeeded" && response.outcome !== "failed") {
      throw new Error(`Worker returned invalid execute outcome: ${response.outcome}`);
    }
    if (response.outcome === "failed" && (response.errorCode === undefined || response.sanitizedError === undefined)) {
      throw new Error("Worker failed result lacks error details");
    }
    if (response.outcome === "succeeded" && response.errorCode !== undefined) {
      throw new Error("Worker success result contains an error");
    }
    return {
      outcome: response.outcome,
      output: response.output,
      evidenceRefs: response.evidenceRefs,
      ...(response.errorCode === undefined
        ? {}
        : { errorCode: response.errorCode, sanitizedError: response.sanitizedError! }),
    };
  }

  async reconcile(intent: OperationIntent): Promise<ReconciliationResult> {
    this.assertRepository(intent);
    const response = await this.callWorker("reconcile", intent);
    if (!["applied", "not_applied", "unknown"].includes(response.outcome)) {
      throw new Error(`Worker returned invalid reconcile outcome: ${response.outcome}`);
    }
    return {
      outcome: response.outcome as ReconciliationResult["outcome"],
      output: response.output,
      evidenceRefs: response.evidenceRefs,
      ...(response.errorCode === undefined
        ? {}
        : { errorCode: response.errorCode, sanitizedError: response.sanitizedError! }),
    };
  }

  private callWorker(
    action: WorkerResponse["action"],
    intent: OperationIntent,
    signal?: AbortSignal,
  ): Promise<WorkerResponse> {
    const payload = JSON.stringify({
      protocolVersion: "1",
      action,
      operationId: intent.operationId,
      rootDir: this.workspaceRoot,
      intent: { toolName: intent.toolName, toolVersion: intent.toolVersion, input: intent.input },
    });
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [this.workerPath], {
        cwd: this.workspaceRoot,
        env: { NODE_NO_WARNINGS: "1", TZ: "UTC" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error, response?: WorkerResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolvePromise(response!);
      };
      const abort = (): void => {
        child.kill("SIGKILL");
        finish(new Error("Workspace worker was aborted after dispatch"));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("Workspace worker timed out after dispatch"));
      }, this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          finish(new Error("Workspace worker output exceeded the limit"));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.concat(stderr).length < MAX_OUTPUT_BYTES) stderr.push(chunk);
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code, closeSignal) => {
        if (settled) return;
        if (code !== 0) {
          finish(new Error(`Workspace worker exited without a result (code=${String(code)}, signal=${String(closeSignal)})`));
          return;
        }
        try {
          finish(undefined, parseResponse(Buffer.concat(stdout).toString("utf8").trim(), action));
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Workspace worker returned invalid JSON"));
        }
      });
      child.stdin.on("error", (error) => finish(error));
      child.stdin.end(payload);
    });
  }

  private assertRepository(intent: OperationIntent): void {
    if (intent.repositoryId !== this.repositoryId) {
      throw new Error(`Executor is not configured for repository: ${intent.repositoryId}`);
    }
  }
}
