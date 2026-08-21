import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { canonicalizeJson, digestJson, isSha256 } from "./canonical-json.js";
import { ToolGatewayError, fail } from "./errors.js";
import { applyMigrations } from "./migrations.js";
import type {
  Clock,
  IdGenerator,
  IsolatedExecutionResult,
  IsolatedToolExecutorPort,
  JsonObject,
  OperationIntent,
  OperationResult,
  OperationTransition,
  PolicyDecision,
  ReconciliationResult,
  RoleRunAuthorityPort,
  RoleRunAuthoritySnapshot,
  ToolDefinitionV1,
  ToolInvocationOutcome,
  ToolInvocationRequest,
  ToolOperation,
  ToolOperationStatus,
  ToolPlanRef,
  ToolPolicyPort,
  VersionedRef,
} from "./types.js";

interface SqlRow {
  [key: string]: null | number | bigint | string | Uint8Array;
}

export interface ToolRegistration {
  definition: ToolDefinitionV1;
  policy: ToolPolicyPort;
}

export interface SqliteToolGatewayConfig {
  databasePath: string;
  authority: RoleRunAuthorityPort;
  executor: IsolatedToolExecutorPort;
  registrations: readonly ToolRegistration[];
  clock?: Clock;
  idGenerator?: IdGenerator;
}

interface ActiveInvocation {
  requestDigest: string;
  promise: Promise<ToolInvocationOutcome>;
}

const systemClock: Clock = { now: () => new Date().toISOString() };
const randomIds: IdGenerator = { next: (prefix) => `${prefix}_${randomUUID()}` };

function asText(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected text column: ${key}`);
  }
  return value;
}

function asNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`Expected numeric column: ${key}`);
  }
  return value;
}

function optionalText(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : asText(row, key);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function requireText(label: string, value: string): void {
  if (value.trim().length === 0) {
    fail("invalid_input", `${label} must not be empty`);
  }
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}

function registrationKey(name: string, version: string): string {
  return `${name}\u0000${version}`;
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 500);
  }
  return "Executor result is unavailable";
}

function operationFromRow(row: SqlRow): ToolOperation {
  return {
    operationId: asText(row, "operation_id"),
    version: asNumber(row, "version"),
    status: asText(row, "status") as ToolOperationStatus,
    idempotencyKey: asText(row, "idempotency_key"),
    requestDigest: asText(row, "request_digest"),
    runId: asText(row, "run_id"),
    roleRunId: asText(row, "role_run_id"),
    leaseToken: asNumber(row, "lease_token"),
    callId: asText(row, "call_id"),
    tool: {
      name: asText(row, "tool_name"),
      version: asText(row, "tool_version"),
      definitionDigest: asText(row, "definition_digest"),
      policyRef: parseJson<VersionedRef>(asText(row, "policy_ref_json")),
    },
    ...(optionalText(row, "error_code") === undefined ? {} : { errorCode: optionalText(row, "error_code")! }),
    ...(optionalText(row, "sanitized_error") === undefined
      ? {}
      : { sanitizedError: optionalText(row, "sanitized_error")! }),
    createdAt: asText(row, "created_at"),
    updatedAt: asText(row, "updated_at"),
    ...(optionalText(row, "terminal_at") === undefined ? {} : { terminalAt: optionalText(row, "terminal_at")! }),
  };
}

function decisionFromRow(row: SqlRow): PolicyDecision {
  return {
    decisionId: asText(row, "decision_id"),
    operationId: asText(row, "operation_id"),
    outcome: asText(row, "outcome") as PolicyDecision["outcome"],
    reasonCodes: parseJson<string[]>(asText(row, "reason_codes_json")),
    authorityDigest: asText(row, "authority_digest"),
    policyRef: parseJson<VersionedRef>(asText(row, "policy_ref_json")),
    decidedAt: asText(row, "decided_at"),
  };
}

function intentFromRow(row: SqlRow): OperationIntent {
  const input = parseJson<JsonObject>(asText(row, "input_json"));
  const inputDigest = asText(row, "input_digest");
  if (digestJson(input) !== inputDigest) {
    throw new Error(`Stored Operation Intent input is corrupt: ${asText(row, "operation_id")}`);
  }
  return {
    intentId: asText(row, "intent_id"),
    operationId: asText(row, "operation_id"),
    schemaVersion: "1",
    toolName: asText(row, "tool_name"),
    toolVersion: asText(row, "tool_version"),
    input,
    inputDigest,
    repositoryId: asText(row, "repository_id"),
    baseCommit: asText(row, "base_commit"),
    allowedPath: asText(row, "allowed_path"),
    isolationProfile: parseJson<VersionedRef>(asText(row, "isolation_profile_json")),
    createdAt: asText(row, "created_at"),
  };
}

function resultFromRow(row: SqlRow): OperationResult {
  const output = parseJson<JsonObject>(asText(row, "output_json"));
  const outputDigest = asText(row, "output_digest");
  if (digestJson(output) !== outputDigest) {
    throw new Error(`Stored Operation Result output is corrupt: ${asText(row, "operation_id")}`);
  }
  return {
    resultId: asText(row, "result_id"),
    operationId: asText(row, "operation_id"),
    outcome: asText(row, "outcome") as OperationResult["outcome"],
    source: asText(row, "source") as OperationResult["source"],
    output,
    outputDigest,
    evidenceRefs: parseJson<string[]>(asText(row, "evidence_refs_json")),
    ...(optionalText(row, "error_code") === undefined ? {} : { errorCode: optionalText(row, "error_code")! }),
    ...(optionalText(row, "sanitized_error") === undefined
      ? {}
      : { sanitizedError: optionalText(row, "sanitized_error")! }),
    createdAt: asText(row, "created_at"),
  };
}

export function deriveToolIdempotencyKey(request: ToolInvocationRequest): string {
  return `tool-call:${digestJson({
    schemaVersion: "1",
    runId: request.runId,
    roleRunId: request.roleRunId,
    callId: request.callId,
    toolName: request.tool.name,
    toolVersion: request.tool.version,
  })}`;
}

export class SqliteToolGateway {
  private readonly database: DatabaseSync;
  private readonly authority: RoleRunAuthorityPort;
  private readonly executor: IsolatedToolExecutorPort;
  private readonly registrations = new Map<string, ToolRegistration>();
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly activeInvocations = new Map<string, ActiveInvocation>();

  constructor(config: SqliteToolGatewayConfig) {
    requireText("databasePath", config.databasePath);
    if (config.registrations.length === 0) {
      fail("invalid_input", "Tool Gateway requires an explicit registration list");
    }
    for (const registration of config.registrations) {
      this.validateRegistration(registration);
      const key = registrationKey(registration.definition.name, registration.definition.version);
      if (this.registrations.has(key)) {
        fail("invalid_input", `Duplicate tool registration: ${registration.definition.name}@${registration.definition.version}`);
      }
      this.registrations.set(key, registration);
    }
    this.authority = config.authority;
    this.executor = config.executor;
    this.clock = config.clock ?? systemClock;
    this.ids = config.idGenerator ?? randomIds;
    const existed = config.databasePath !== ":memory:" && existsSync(config.databasePath);
    this.database = new DatabaseSync(config.databasePath, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    applyMigrations(this.database, () => this.clock.now());
    if (config.databasePath !== ":memory:" && !existed) {
      chmodSync(config.databasePath, 0o600);
    }
  }

  close(): void {
    this.database.close();
  }

  async invoke(request: ToolInvocationRequest, signal?: AbortSignal): Promise<ToolInvocationOutcome> {
    this.validateRequest(request);
    let requestDigest: string;
    try {
      requestDigest = digestJson(request);
    } catch (error) {
      fail("invalid_input", sanitizeError(error));
    }
    const idempotencyKey = deriveToolIdempotencyKey(request);
    const active = this.activeInvocations.get(idempotencyKey);
    if (active !== undefined) {
      if (active.requestDigest !== requestDigest) {
        fail("idempotency_conflict", `Tool call was reused with different input: ${request.callId}`);
      }
      return active.promise;
    }
    const promise = this.invokeSerialized(request, requestDigest, idempotencyKey, signal).finally(() => {
      this.activeInvocations.delete(idempotencyKey);
    });
    this.activeInvocations.set(idempotencyKey, { requestDigest, promise });
    return promise;
  }

  async reconcile(operationId: string): Promise<ToolInvocationOutcome> {
    requireText("operationId", operationId);
    const operation = this.getOperation(operationId);
    const active = this.activeInvocations.get(operation.idempotencyKey);
    if (active !== undefined) {
      return active.promise;
    }
    const promise = this.reconcileSerialized(operation).finally(() => {
      this.activeInvocations.delete(operation.idempotencyKey);
    });
    this.activeInvocations.set(operation.idempotencyKey, { requestDigest: operation.requestDigest, promise });
    return promise;
  }

  getOperation(operationId: string): ToolOperation {
    const row = this.database.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId) as
      | SqlRow
      | undefined;
    if (row === undefined) {
      fail("not_found", `Tool Operation not found: ${operationId}`);
    }
    return operationFromRow(row);
  }

  getDecision(operationId: string): PolicyDecision {
    const row = this.database.prepare("SELECT * FROM policy_decisions WHERE operation_id = ?").get(operationId) as
      | SqlRow
      | undefined;
    if (row === undefined) {
      fail("not_found", `Policy Decision not found for Operation: ${operationId}`);
    }
    return decisionFromRow(row);
  }

  getIntent(operationId: string): OperationIntent {
    const row = this.database.prepare("SELECT * FROM operation_intents WHERE operation_id = ?").get(operationId) as
      | SqlRow
      | undefined;
    if (row === undefined) {
      fail("not_found", `Operation Intent not found: ${operationId}`);
    }
    return intentFromRow(row);
  }

  getResult(operationId: string): OperationResult | undefined {
    const row = this.database.prepare("SELECT * FROM operation_results WHERE operation_id = ?").get(operationId) as
      | SqlRow
      | undefined;
    return row === undefined ? undefined : resultFromRow(row);
  }

  listTransitions(operationId: string): OperationTransition[] {
    return (this.database
      .prepare("SELECT * FROM operation_transitions WHERE operation_id = ? ORDER BY to_version")
      .all(operationId) as SqlRow[]).map((row) => ({
      transitionId: asText(row, "transition_id"),
      operationId: asText(row, "operation_id"),
      ...(optionalText(row, "from_status") === undefined
        ? {}
        : { fromStatus: optionalText(row, "from_status") as ToolOperationStatus }),
      toStatus: asText(row, "to_status") as ToolOperationStatus,
      ...(row.from_version === null ? {} : { fromVersion: asNumber(row, "from_version") }),
      toVersion: asNumber(row, "to_version"),
      reasonCode: asText(row, "reason_code"),
      occurredAt: asText(row, "occurred_at"),
    }));
  }

  listUnsettledOperations(roleRunId?: string): ToolOperation[] {
    const rows = roleRunId === undefined
      ? this.database.prepare("SELECT * FROM operations WHERE status IN ('authorized', 'executing', 'unknown') ORDER BY created_at, operation_id").all()
      : this.database
          .prepare("SELECT * FROM operations WHERE role_run_id = ? AND status IN ('authorized', 'executing', 'unknown') ORDER BY created_at, operation_id")
          .all(roleRunId);
    return (rows as SqlRow[]).map(operationFromRow);
  }

  private async invokeSerialized(
    request: ToolInvocationRequest,
    requestDigest: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ToolInvocationOutcome> {
    const existing = this.findByIdempotencyKey(idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) {
        fail("idempotency_conflict", `Tool call was reused with different input: ${request.callId}`);
      }
      if (["denied", "failed", "succeeded"].includes(existing.status)) {
        return this.outcome(existing);
      }
      if (existing.status === "authorized") {
        try {
          await this.authority.authorize(request);
        } catch (error) {
          return this.finishKnownFailure(
            existing,
            "authorization_expired_before_execution",
            error instanceof ToolGatewayError ? error.message : "Control Plane authority check was unavailable",
            "execution",
          );
        }
        return this.dispatch(existing, signal);
      }
      return this.reconcileOperation(existing);
    }

    const registration = this.registrations.get(registrationKey(request.tool.name, request.tool.version));
    let authority: RoleRunAuthoritySnapshot | undefined;
    let decisionOutcome: "allow" | "deny" = "deny";
    let reasonCodes: readonly string[] = ["tool_not_registered"];
    let normalizedInput: JsonObject | undefined;
    let allowedPath: string | undefined;
    let sanitizedError: string | undefined;

    if (registration !== undefined && registration.definition.definitionDigest !== request.tool.definitionDigest) {
      reasonCodes = ["tool_definition_mismatch"];
    } else if (registration !== undefined && !sameRef(registration.policy.ref, request.tool.policyRef)) {
      reasonCodes = ["tool_policy_mismatch"];
    } else if (registration !== undefined) {
      try {
        authority = await this.authority.authorize(request);
        const evaluation = registration.policy.evaluate(authority, request.input);
        decisionOutcome = evaluation.outcome;
        reasonCodes = evaluation.reasonCodes;
        normalizedInput = evaluation.normalizedInput;
        allowedPath = evaluation.allowedPath;
      } catch (error) {
        reasonCodes = [error instanceof ToolGatewayError ? error.code : "authority_unavailable"];
        sanitizedError = error instanceof ToolGatewayError ? error.message : "Control Plane authority check was unavailable";
      }
    }

    const operation = this.createOperation({
      request,
      requestDigest,
      idempotencyKey,
      decisionOutcome,
      reasonCodes,
      ...(authority === undefined ? {} : { authority }),
      ...(normalizedInput === undefined ? {} : { normalizedInput }),
      ...(allowedPath === undefined ? {} : { allowedPath }),
      ...(sanitizedError === undefined ? {} : { sanitizedError }),
    });
    if (operation.status === "denied") {
      return this.outcome(operation);
    }
    return this.dispatch(operation, signal);
  }

  private createOperation(input: {
    request: ToolInvocationRequest;
    requestDigest: string;
    idempotencyKey: string;
    decisionOutcome: "allow" | "deny";
    reasonCodes: readonly string[];
    authority?: RoleRunAuthoritySnapshot;
    normalizedInput?: JsonObject;
    allowedPath?: string;
    sanitizedError?: string;
  }): ToolOperation {
    if (
      input.decisionOutcome === "allow" &&
      (input.authority === undefined || input.normalizedInput === undefined || input.allowedPath === undefined)
    ) {
      fail("invalid_input", "Allowed policy decision requires an authority snapshot and normalized intent");
    }
    const now = this.clock.now();
    const operationId = this.ids.next("operation");
    const decisionId = this.ids.next("decision");
    const intentId = input.decisionOutcome === "allow" ? this.ids.next("intent") : undefined;
    const status: ToolOperationStatus = input.decisionOutcome === "allow" ? "authorized" : "denied";
    const authorityDigest = digestJson(input.authority ?? {
      runId: input.request.runId,
      roleRunId: input.request.roleRunId,
      leaseToken: input.request.leaseToken,
      unavailable: true,
    });
    const errorCode = status === "denied" ? input.reasonCodes[0] ?? "policy_denied" : undefined;
    const sanitizedError = status === "denied" ? input.sanitizedError ?? "Tool request was denied" : undefined;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`
          INSERT INTO operations (
            operation_id, version, status, idempotency_key, request_digest, run_id, role_run_id,
            lease_token, call_id, tool_name, tool_version, definition_digest, policy_ref_json,
            error_code, sanitized_error, created_at, updated_at, terminal_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          operationId,
          status,
          input.idempotencyKey,
          input.requestDigest,
          input.request.runId,
          input.request.roleRunId,
          input.request.leaseToken,
          input.request.callId,
          input.request.tool.name,
          input.request.tool.version,
          input.request.tool.definitionDigest,
          canonicalizeJson(input.request.tool.policyRef),
          errorCode ?? null,
          sanitizedError ?? null,
          now,
          now,
          status === "denied" ? now : null,
        );
      this.database
        .prepare(`
          INSERT INTO policy_decisions (
            decision_id, operation_id, outcome, reason_codes_json, authority_digest, policy_ref_json, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          decisionId,
          operationId,
          input.decisionOutcome,
          canonicalizeJson([...input.reasonCodes]),
          authorityDigest,
          canonicalizeJson(input.request.tool.policyRef),
          now,
        );
      if (intentId !== undefined && input.authority !== undefined && input.normalizedInput !== undefined && input.allowedPath !== undefined) {
        const inputJson = canonicalizeJson(input.normalizedInput);
        this.database
          .prepare(`
            INSERT INTO operation_intents (
              intent_id, operation_id, schema_version, tool_name, tool_version, input_json, input_digest,
              repository_id, base_commit, allowed_path, isolation_profile_json, created_at
            ) VALUES (?, ?, '1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            intentId,
            operationId,
            input.request.tool.name,
            input.request.tool.version,
            inputJson,
            digestJson(input.normalizedInput),
            input.authority.repositoryId,
            input.authority.baseCommit,
            input.allowedPath,
            canonicalizeJson(input.authority.isolationProfile),
            now,
          );
      }
      this.insertTransition(operationId, undefined, status, undefined, 1, status === "denied" ? "request_denied" : "intent_authorized", now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing !== undefined) {
        if (existing.requestDigest !== input.requestDigest) {
          fail("idempotency_conflict", `Idempotency key conflicts with another request: ${input.idempotencyKey}`);
        }
        return existing;
      }
      throw error;
    }
    return this.getOperation(operationId);
  }

  private async dispatch(operation: ToolOperation, signal?: AbortSignal): Promise<ToolInvocationOutcome> {
    if (operation.status !== "authorized") {
      fail("invalid_transition", `Operation cannot execute from ${operation.status}: ${operation.operationId}`);
    }
    if (signal?.aborted === true) {
      return this.finishKnownFailure(operation, "cancelled_before_execution", "Tool call was cancelled before dispatch", "execution");
    }
    const intent = this.getIntent(operation.operationId);
    this.assertIntentMatchesOperation(operation, intent);
    const executing = this.transition(operation, "executing", "intent_dispatched");
    try {
      const result = await this.executor.execute(intent, signal);
      return this.finishExecution(executing, result, "execution");
    } catch (error) {
      const unknown = this.transition(
        executing,
        "unknown",
        "executor_result_unknown",
        "executor_result_unknown",
        "Isolated executor did not return a trustworthy result",
      );
      return this.outcome(unknown);
    }
  }

  private async reconcileSerialized(operation: ToolOperation): Promise<ToolInvocationOutcome> {
    const current = this.getOperation(operation.operationId);
    if (["denied", "failed", "succeeded"].includes(current.status)) {
      return this.outcome(current);
    }
    if (current.status === "authorized") {
      return this.finishKnownFailure(current, "not_dispatched", "Operation intent was never dispatched", "reconciliation");
    }
    return this.reconcileOperation(current);
  }

  private async reconcileOperation(operation: ToolOperation): Promise<ToolInvocationOutcome> {
    if (operation.status !== "executing" && operation.status !== "unknown") {
      fail("invalid_transition", `Operation cannot be reconciled from ${operation.status}: ${operation.operationId}`);
    }
    const intent = this.getIntent(operation.operationId);
    this.assertIntentMatchesOperation(operation, intent);
    let result: ReconciliationResult;
    try {
      result = await this.executor.reconcile(intent);
    } catch (error) {
      const unknown = this.transition(
        operation,
        "unknown",
        "reconciliation_unavailable",
        "reconciliation_unavailable",
        "Isolated reconciliation did not return a trustworthy result",
      );
      return this.outcome(unknown);
    }
    if (result.outcome === "applied") {
      return this.finishExecution(
        operation,
        { outcome: "succeeded", output: result.output, evidenceRefs: result.evidenceRefs },
        "reconciliation",
      );
    }
    if (result.outcome === "not_applied") {
      return this.finishExecution(
        operation,
        {
          outcome: "failed",
          output: result.output,
          evidenceRefs: result.evidenceRefs,
          errorCode: result.errorCode ?? "not_applied",
          sanitizedError: result.sanitizedError ?? "Reconciliation proved that the intent was not applied",
        },
        "reconciliation",
      );
    }
    const unknown = this.transition(
      operation,
      "unknown",
      "reconciliation_inconclusive",
      result.errorCode ?? "reconciliation_inconclusive",
      result.sanitizedError ?? "Target state does not prove whether the intent was applied",
    );
    return this.outcome(unknown);
  }

  private finishKnownFailure(
    operation: ToolOperation,
    errorCode: string,
    sanitizedError: string,
    source: OperationResult["source"],
  ): ToolInvocationOutcome {
    return this.finishExecution(
      operation,
      { outcome: "failed", output: {}, evidenceRefs: [], errorCode, sanitizedError },
      source,
    );
  }

  private finishExecution(
    operation: ToolOperation,
    execution: IsolatedExecutionResult,
    source: OperationResult["source"],
  ): ToolInvocationOutcome {
    if (execution.outcome === "failed" && (execution.errorCode === undefined || execution.sanitizedError === undefined)) {
      fail("invalid_input", "Failed executor result requires an error code and sanitized error");
    }
    if (execution.outcome === "succeeded" && (execution.errorCode !== undefined || execution.sanitizedError !== undefined)) {
      fail("invalid_input", "Successful executor result cannot contain an error");
    }
    const now = this.clock.now();
    const status: ToolOperationStatus = execution.outcome;
    const resultId = this.ids.next("result");
    const outputJson = canonicalizeJson(execution.output);
    const evidenceRefs = [...new Set(execution.evidenceRefs)].sort();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`
          INSERT INTO operation_results (
            result_id, operation_id, outcome, source, output_json, output_digest,
            evidence_refs_json, error_code, sanitized_error, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          resultId,
          operation.operationId,
          execution.outcome,
          source,
          outputJson,
          digestJson(execution.output),
          canonicalizeJson(evidenceRefs),
          execution.errorCode ?? null,
          execution.sanitizedError ?? null,
          now,
        );
      this.updateOperation(
        operation,
        status,
        execution.outcome === "failed" ? execution.errorCode : undefined,
        execution.outcome === "failed" ? execution.sanitizedError : undefined,
        now,
      );
      this.insertTransition(
        operation.operationId,
        operation.status,
        status,
        operation.version,
        operation.version + 1,
        source === "reconciliation" ? `reconciled_${status}` : `execution_${status}`,
        now,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      const current = this.getOperation(operation.operationId);
      if (["failed", "succeeded"].includes(current.status)) {
        return this.outcome(current);
      }
      throw error;
    }
    return this.outcome(this.getOperation(operation.operationId));
  }

  private transition(
    operation: ToolOperation,
    status: ToolOperationStatus,
    reasonCode: string,
    errorCode?: string,
    sanitizedError?: string,
  ): ToolOperation {
    const now = this.clock.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.updateOperation(operation, status, errorCode, sanitizedError, now);
      this.insertTransition(
        operation.operationId,
        operation.status,
        status,
        operation.version,
        operation.version + 1,
        reasonCode,
        now,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getOperation(operation.operationId);
  }

  private updateOperation(
    operation: ToolOperation,
    status: ToolOperationStatus,
    errorCode: string | undefined,
    sanitizedError: string | undefined,
    now: string,
  ): void {
    const terminalAt = ["denied", "failed", "succeeded"].includes(status) ? now : null;
    const result = this.database
      .prepare(`
        UPDATE operations
        SET version = ?, status = ?, error_code = ?, sanitized_error = ?, updated_at = ?, terminal_at = ?
        WHERE operation_id = ? AND version = ? AND status = ?
      `)
      .run(
        operation.version + 1,
        status,
        errorCode ?? null,
        sanitizedError ?? null,
        now,
        terminalAt,
        operation.operationId,
        operation.version,
        operation.status,
      );
    if (result.changes !== 1) {
      fail("invalid_transition", `Operation changed concurrently: ${operation.operationId}`);
    }
  }

  private insertTransition(
    operationId: string,
    fromStatus: ToolOperationStatus | undefined,
    toStatus: ToolOperationStatus,
    fromVersion: number | undefined,
    toVersion: number,
    reasonCode: string,
    occurredAt: string,
  ): void {
    this.database
      .prepare(`
        INSERT INTO operation_transitions (
          transition_id, operation_id, from_status, to_status, from_version, to_version, reason_code, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        this.ids.next("transition"),
        operationId,
        fromStatus ?? null,
        toStatus,
        fromVersion ?? null,
        toVersion,
        reasonCode,
        occurredAt,
      );
  }

  private outcome(operation: ToolOperation): ToolInvocationOutcome {
    const result = this.getResult(operation.operationId);
    return {
      operation,
      decision: this.getDecision(operation.operationId),
      ...(result === undefined ? {} : { result }),
    };
  }

  private findByIdempotencyKey(idempotencyKey: string): ToolOperation | undefined {
    const row = this.database.prepare("SELECT * FROM operations WHERE idempotency_key = ?").get(idempotencyKey) as
      | SqlRow
      | undefined;
    return row === undefined ? undefined : operationFromRow(row);
  }

  private validateRequest(request: ToolInvocationRequest): void {
    requireText("runId", request.runId);
    requireText("roleRunId", request.roleRunId);
    requireText("callId", request.callId);
    requireText("tool.name", request.tool.name);
    requireText("tool.version", request.tool.version);
    if (!Number.isSafeInteger(request.leaseToken) || request.leaseToken <= 0) {
      fail("invalid_input", "leaseToken must be a positive integer");
    }
    if (!isSha256(request.tool.definitionDigest) || !isSha256(request.tool.policyRef.digest)) {
      fail("invalid_input", "Tool and policy references require SHA-256 digests");
    }
    requireText("tool.policyRef.id", request.tool.policyRef.id);
    requireText("tool.policyRef.version", request.tool.policyRef.version);
    if (request.input === null || Array.isArray(request.input) || typeof request.input !== "object") {
      fail("invalid_input", "Tool input must be an object");
    }
  }

  private validateRegistration(registration: ToolRegistration): void {
    const { definitionDigest, ...document } = registration.definition;
    requireText("tool definition name", document.name);
    requireText("tool definition version", document.version);
    requireText("tool definition description", document.description);
    if (!isSha256(definitionDigest) || digestJson(document) !== definitionDigest) {
      fail("definition_mismatch", `Tool definition digest is invalid: ${document.name}@${document.version}`);
    }
    if (document.inputSchema.type !== "object") {
      fail("invalid_input", `Tool input Schema must describe an object: ${document.name}`);
    }
    if (!isSha256(registration.policy.ref.digest)) {
      fail("invalid_input", `Tool policy digest is invalid: ${registration.policy.ref.id}`);
    }
  }

  private assertIntentMatchesOperation(operation: ToolOperation, intent: OperationIntent): void {
    if (
      intent.operationId !== operation.operationId ||
      intent.toolName !== operation.tool.name ||
      intent.toolVersion !== operation.tool.version ||
      intent.input.path !== intent.allowedPath
    ) {
      throw new Error(`Stored Operation Intent does not match Operation: ${operation.operationId}`);
    }
  }
}
