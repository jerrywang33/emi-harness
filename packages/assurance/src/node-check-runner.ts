import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { digestJson, isSha256 } from "./canonical-json.js";
import { fail } from "./errors.js";
import type { CheckDefinitionV1, CheckExecutionRequest, CheckObservation, CheckRunnerPort, Clock } from "./types.js";

export interface NodeCheckRunnerConfig {
  repositoryId: string;
  workspaceRoot: string;
  maxOutputBytes?: number;
  maxTimeoutMs?: number;
  clock?: Clock;
}

interface ProcessObservation {
  exitCode?: number;
  signal?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  errorCode?: string;
}

const systemClock: Clock = { now: () => new Date().toISOString() };
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_TIMEOUT_MS = 60_000;

function validRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function validateDefinition(ref: CheckExecutionRequest["check"]["ref"], definition: CheckDefinitionV1, maxTimeoutMs: number): void {
  const keys = Object.keys(definition).sort();
  if (keys.join("\0") !== ["args", "expectedExitCode", "runner", "schemaVersion", "scriptPath", "timeoutMs"].join("\0")) {
    fail("invalid_check", `Check definition has an invalid shape: ${ref.id}@${ref.version}`);
  }
  if (definition.schemaVersion !== "1" || definition.runner !== "node_script") {
    fail("invalid_check", `Unsupported Check definition: ${ref.id}@${ref.version}`);
  }
  if (!validRelativePath(definition.scriptPath) || !definition.scriptPath.endsWith(".mjs")) {
    fail("invalid_check", "Node check scriptPath must be a normalized relative .mjs path");
  }
  if (
    !Array.isArray(definition.args) ||
    definition.args.length > 20 ||
    definition.args.some((arg) => typeof arg !== "string" || arg.length > 256 || arg.includes("\0"))
  ) {
    fail("invalid_check", "Node check args exceed the v0.1 boundary");
  }
  if (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs <= 0 || definition.timeoutMs > maxTimeoutMs) {
    fail("invalid_check", `Check timeout exceeds Runner limit: ${definition.timeoutMs}`);
  }
  if (!Number.isSafeInteger(definition.expectedExitCode) || definition.expectedExitCode < 0 || definition.expectedExitCode > 255) {
    fail("invalid_check", "expectedExitCode must be between 0 and 255");
  }
  if (!isSha256(ref.digest) || digestJson(definition) !== ref.digest) {
    fail("invalid_check", `Check definition digest mismatch: ${ref.id}@${ref.version}`);
  }
}

export class NodeCheckRunner implements CheckRunnerPort {
  private constructor(
    private readonly repositoryId: string,
    private readonly workspaceRoot: string,
    private readonly maxOutputBytes: number,
    private readonly maxTimeoutMs: number,
    private readonly clock: Clock,
  ) {}

  static async create(config: NodeCheckRunnerConfig): Promise<NodeCheckRunner> {
    if (config.repositoryId.trim().length === 0 || !isAbsolute(config.workspaceRoot)) {
      fail("invalid_input", "NodeCheckRunner requires a repositoryId and absolute workspaceRoot");
    }
    const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const maxTimeoutMs = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > 1024 * 1024) {
      fail("invalid_input", "maxOutputBytes must be between 1 and 1048576");
    }
    if (!Number.isSafeInteger(maxTimeoutMs) || maxTimeoutMs <= 0 || maxTimeoutMs > 300_000) {
      fail("invalid_input", "maxTimeoutMs must be between 1 and 300000");
    }
    return new NodeCheckRunner(
      config.repositoryId,
      await realpath(config.workspaceRoot),
      maxOutputBytes,
      maxTimeoutMs,
      config.clock ?? systemClock,
    );
  }

  async run(request: CheckExecutionRequest): Promise<CheckObservation> {
    if (request.target.repositoryId !== this.repositoryId) {
      fail("invalid_check", `Check target repository mismatch: ${request.target.repositoryId}`);
    }
    if (!/^[0-9a-f]{40,64}$/u.test(request.target.baseCommit)) {
      fail("invalid_check", "Check target baseCommit must be a fixed Git object ID");
    }
    validateDefinition(request.check.ref, request.check.definition, this.maxTimeoutMs);
    const requestedScript = resolve(this.workspaceRoot, request.check.definition.scriptPath);
    let scriptPath: string;
    try {
      const stat = await lstat(requestedScript);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Check script must be a regular file");
      scriptPath = await realpath(requestedScript);
      if (!scriptPath.startsWith(`${this.workspaceRoot}${sep}`)) throw new Error("Check script escapes workspace root");
    } catch (error) {
      fail("invalid_check", error instanceof Error ? error.message : "Check script cannot be loaded safely");
    }
    const startedAt = this.clock.now();
    const processResult = await this.runProcess(scriptPath, request.check.definition.args, request.check.definition.timeoutMs);
    const endedAt = this.clock.now();
    const outcome = processResult.errorCode !== undefined
      ? "blocked"
      : processResult.exitCode === request.check.definition.expectedExitCode
        ? "passed"
        : "failed";
    return {
      schemaVersion: "1",
      taskId: request.taskId,
      runId: request.runId,
      roleRunId: request.roleRunId,
      repositoryId: request.target.repositoryId,
      baseCommit: request.target.baseCommit,
      check: { ...request.check.ref },
      runner: "node_script",
      scriptPath: request.check.definition.scriptPath,
      args: [...request.check.definition.args],
      outcome,
      expectedExitCode: request.check.definition.expectedExitCode,
      ...(processResult.exitCode === undefined ? {} : { exitCode: processResult.exitCode }),
      ...(processResult.signal === undefined ? {} : { signal: processResult.signal }),
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      stdoutTruncated: processResult.stdoutTruncated,
      stderrTruncated: processResult.stderrTruncated,
      startedAt,
      endedAt,
      ...(processResult.errorCode === undefined ? {} : { errorCode: processResult.errorCode }),
    };
  }

  private runProcess(scriptPath: string, args: readonly string[], timeoutMs: number): Promise<ProcessObservation> {
    return new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [scriptPath, ...args], {
        cwd: this.workspaceRoot,
        env: { NODE_NO_WARNINGS: "1", TZ: "UTC" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timeout = false;
      let spawnError = false;
      const append = (chunks: Buffer[], chunk: Buffer, current: number): number => {
        const remaining = this.maxOutputBytes - current;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        return current + chunk.length;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes = append(stdout, chunk, stdoutBytes);
        if (stdoutBytes > this.maxOutputBytes) stdoutTruncated = true;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes = append(stderr, chunk, stderrBytes);
        if (stderrBytes > this.maxOutputBytes) stderrTruncated = true;
      });
      child.on("error", () => {
        spawnError = true;
      });
      const timer = setTimeout(() => {
        timeout = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolvePromise({
          ...(typeof exitCode === "number" ? { exitCode } : {}),
          ...(signal === null ? {} : { signal }),
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdoutTruncated,
          stderrTruncated,
          ...(timeout ? { errorCode: "check_timeout" } : spawnError ? { errorCode: "check_spawn_failed" } : {}),
        });
      });
    });
  }
}
