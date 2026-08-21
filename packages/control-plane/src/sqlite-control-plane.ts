import { chmodSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { canonicalizeJson, digestJson, normalizeRunManifest, sha256Digest } from "./canonical-json.js";
import type {
  AcceptDeliveryCommand,
  AcquireRoleRunLeaseCommand,
  CancelTaskCommand,
  CompleteContextualizationCommand,
  CreateTaskCommand,
  FinishRunStopCommand,
  InvalidateApprovalCommand,
  MarkOutboxDeliveredCommand,
  MarkRoleRunRunningCommand,
  MarkRoleRunSettlingCommand,
  PrepareRoleRunCommand,
  RecordApprovalDecisionCommand,
  RegisterArtifactCommand,
  RequestAcceptanceReworkCommand,
  SealRunManifestCommand,
  SettleRoleRunCommand,
  StartContextualizationCommand,
  SubmitExecutionForVerificationCommand,
  SubmitTrdForApprovalCommand,
  SubmitVerificationResultCommand,
} from "./contracts.js";
import { ControlPlaneError, fail } from "./errors.js";
import { applyMigrations } from "./migrations.js";
import type {
  Actor,
  Approval,
  ApprovalCondition,
  ApprovalDecisionValue,
  ApprovalStatus,
  Artifact,
  ArtifactInput,
  Clock,
  IdGenerator,
  JsonValue,
  RecoveryAction,
  RoleRun,
  RoleRunStatus,
  Run,
  RunManifestV1,
  StoredTransition,
  Task,
  TaskStatus,
  VersionedRef,
} from "./types.js";

interface SqlRow {
  [key: string]: null | number | bigint | string | Uint8Array;
}

export interface SqliteControlPlaneConfig {
  databasePath: string;
  clock?: Clock;
  idGenerator?: IdGenerator;
}

interface TaskChange {
  status: TaskStatus;
  contextManifest?: VersionedRef;
  trd?: VersionedRef;
  outcome?: "completed" | "cancelled";
  blockedReason?: string;
  resumeToStatus?: TaskStatus;
  closedAt?: string;
  actor: Actor;
  commandId: string;
  reasonCode: string;
  refs: readonly VersionedRef[];
  evidenceRefs?: readonly string[];
}

interface RunChange {
  status: Run["status"];
  outcome?: Run["outcome"];
  pendingOutcome?: Run["pendingOutcome"];
  resumeToStatus?: Run["resumeToStatus"];
  reasonCode: string;
  settledAt?: string;
  actor: Actor;
  commandId: string;
  refs: readonly VersionedRef[];
  evidenceRefs: readonly string[];
}

interface RoleRunChange {
  status: RoleRunStatus;
  outcome?: RoleRun["outcome"];
  runtimeOutcome?: RoleRun["runtimeOutcome"];
  sessionId?: string;
  outputArtifacts?: readonly VersionedRef[];
  toolOperationRefs?: readonly string[];
  evidenceRefs?: readonly string[];
  leaseOwner?: string;
  leaseExpiresAt?: string;
  leaseToken: number;
  startedAt?: string;
  runtimeEndedAt?: string;
  settledAt?: string;
  errorCode?: string;
  sanitizedError?: string;
  clearLease?: boolean;
  actor: Actor;
  commandId: string;
  reasonCode: string;
}

interface InitialTransition {
  commandId: string;
  toStatus: string;
  toVersion: number;
  actor: Actor;
  reasonCode: string;
  refs: readonly VersionedRef[];
  evidenceRefs: readonly string[];
  occurredAt: string;
}

interface ApprovalCreation {
  approvalId: string;
  taskId: string;
  gate: Approval["gate"];
  subjectType: string;
  subject: VersionedRef;
  policyVersion: string;
  requiredRoles: readonly string[];
  requestedBy: string;
  expiresAt?: string;
  commandId: string;
  actor: Actor;
  now: string;
}

interface DecisionRow extends SqlRow {
  decision: string;
  authority_role: string;
  conditions_json: string;
}

const systemClock: Clock = { now: () => new Date().toISOString() };
const randomIds: IdGenerator = { next: (prefix) => `${prefix}_${randomUUID()}` };

function requireText(label: string, value: string): void {
  if (value.trim().length === 0) {
    fail("invalid_input", `${label} must not be empty`);
  }
}

function requirePositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("invalid_input", `${label} must be a positive integer`);
  }
}

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

function optionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : asNumber(row, key);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function uniqueSorted(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => {
    requireText(label, value);
    return value;
  });
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) {
    fail("invalid_input", `${label} must not contain duplicates`);
  }
  return unique;
}

function validateActor(actor: Actor): void {
  requireText("actorId", actor.actorId);
  uniqueSorted(actor.roles, "actor role");
}

function refFromColumns(row: SqlRow, prefix: string): VersionedRef | undefined {
  const id = optionalText(row, `${prefix}_id`);
  if (id === undefined) {
    return undefined;
  }
  return {
    id,
    version: asText(row, `${prefix}_version`),
    digest: asText(row, `${prefix}_digest`),
  };
}

function taskFromRow(row: SqlRow): Task {
  return {
    taskId: asText(row, "task_id"),
    version: asNumber(row, "version"),
    status: asText(row, "status") as Task["status"],
    goal: asText(row, "goal"),
    prd: refFromColumns(row, "prd")!,
    ...(refFromColumns(row, "context") === undefined ? {} : { contextManifest: refFromColumns(row, "context")! }),
    ...(refFromColumns(row, "trd") === undefined ? {} : { trd: refFromColumns(row, "trd")! }),
    ...(optionalText(row, "outcome") === undefined
      ? {}
      : { outcome: optionalText(row, "outcome") as NonNullable<Task["outcome"]> }),
    ...(optionalText(row, "blocked_reason") === undefined
      ? {}
      : { blockedReason: optionalText(row, "blocked_reason")!, resumeToStatus: optionalText(row, "resume_to_status") as TaskStatus }),
    createdAt: asText(row, "created_at"),
    updatedAt: asText(row, "updated_at"),
    ...(optionalText(row, "closed_at") === undefined ? {} : { closedAt: optionalText(row, "closed_at")! }),
  };
}

function approvalFromRow(row: SqlRow): Approval {
  return {
    approvalId: asText(row, "approval_id"),
    taskId: asText(row, "task_id"),
    version: asNumber(row, "version"),
    gate: asText(row, "gate_type") as Approval["gate"],
    subjectType: asText(row, "subject_type"),
    subject: {
      id: asText(row, "subject_id"),
      version: asText(row, "subject_version"),
      digest: asText(row, "subject_digest"),
    },
    policyVersion: asText(row, "policy_version"),
    requiredRoles: parseJson<string[]>(asText(row, "required_roles_json")),
    requestedBy: asText(row, "requested_by"),
    status: asText(row, "status") as ApprovalStatus,
    ...(optionalText(row, "expires_at") === undefined ? {} : { expiresAt: optionalText(row, "expires_at")! }),
    createdAt: asText(row, "created_at"),
    updatedAt: asText(row, "updated_at"),
  };
}

function runFromRow(row: SqlRow): Run {
  return {
    runId: asText(row, "run_id"),
    taskId: asText(row, "task_id"),
    version: asNumber(row, "version"),
    manifestDigest: asText(row, "manifest_digest"),
    authorizationApprovalId: asText(row, "authorization_approval_id"),
    status: asText(row, "status") as Run["status"],
    ...(optionalText(row, "outcome") === undefined
      ? {}
      : { outcome: optionalText(row, "outcome") as NonNullable<Run["outcome"]> }),
    ...(optionalText(row, "pending_outcome") === undefined
      ? {}
      : { pendingOutcome: optionalText(row, "pending_outcome") as NonNullable<Run["pendingOutcome"]> }),
    ...(optionalText(row, "resume_to_status") === undefined
      ? {}
      : { resumeToStatus: optionalText(row, "resume_to_status") as NonNullable<Run["resumeToStatus"]> }),
    ...(optionalText(row, "reason_code") === undefined ? {} : { reasonCode: optionalText(row, "reason_code")! }),
    createdAt: asText(row, "created_at"),
    updatedAt: asText(row, "updated_at"),
    ...(optionalText(row, "settled_at") === undefined ? {} : { settledAt: optionalText(row, "settled_at")! }),
  };
}

function roleRunFromRow(row: SqlRow): RoleRun {
  return {
    roleRunId: asText(row, "role_run_id"),
    runId: asText(row, "run_id"),
    rolePlanId: asText(row, "role_plan_id"),
    role: asText(row, "role") as RoleRun["role"],
    attempt: asNumber(row, "attempt"),
    version: asNumber(row, "version"),
    status: asText(row, "status") as RoleRunStatus,
    ...(optionalText(row, "outcome") === undefined
      ? {}
      : { outcome: optionalText(row, "outcome") as NonNullable<RoleRun["outcome"]> }),
    ...(optionalText(row, "runtime_outcome") === undefined
      ? {}
      : { runtimeOutcome: optionalText(row, "runtime_outcome") as NonNullable<RoleRun["runtimeOutcome"]> }),
    ...(optionalText(row, "session_id") === undefined ? {} : { sessionId: optionalText(row, "session_id")! }),
    inputArtifacts: parseJson<VersionedRef[]>(asText(row, "input_artifacts_json")),
    outputArtifacts: parseJson<VersionedRef[]>(asText(row, "output_artifacts_json")),
    toolOperationRefs: parseJson<string[]>(asText(row, "tool_operation_refs_json")),
    evidenceRefs: parseJson<string[]>(asText(row, "evidence_refs_json")),
    ...(optionalText(row, "lease_owner") === undefined ? {} : { leaseOwner: optionalText(row, "lease_owner")! }),
    ...(optionalText(row, "lease_expires_at") === undefined
      ? {}
      : { leaseExpiresAt: optionalText(row, "lease_expires_at")! }),
    leaseToken: asNumber(row, "lease_token"),
    preparedAt: asText(row, "prepared_at"),
    ...(optionalText(row, "started_at") === undefined ? {} : { startedAt: optionalText(row, "started_at")! }),
    ...(optionalText(row, "runtime_ended_at") === undefined
      ? {}
      : { runtimeEndedAt: optionalText(row, "runtime_ended_at")! }),
    ...(optionalText(row, "settled_at") === undefined ? {} : { settledAt: optionalText(row, "settled_at")! }),
    ...(optionalText(row, "error_code") === undefined ? {} : { errorCode: optionalText(row, "error_code")! }),
    ...(optionalText(row, "sanitized_error") === undefined
      ? {}
      : { sanitizedError: optionalText(row, "sanitized_error")! }),
  };
}

export class SqliteControlPlane {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(config: SqliteControlPlaneConfig) {
    requireText("databasePath", config.databasePath);
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

  registerArtifact(command: RegisterArtifactCommand): Artifact {
    return this.command("register_artifact", command, () => this.insertArtifact(command.artifact, this.clock.now()));
  }

  getArtifact(ref: VersionedRef): Artifact {
    const row = this.database
      .prepare("SELECT * FROM artifacts WHERE artifact_id = ? AND artifact_version = ?")
      .get(ref.id, ref.version) as SqlRow | undefined;
    if (row === undefined) {
      fail("not_found", `Artifact not found: ${ref.id}@${ref.version}`);
    }
    const artifact = this.artifactFromRow(row);
    if (artifact.digest !== ref.digest) {
      fail("digest_mismatch", `Artifact digest mismatch: ${ref.id}@${ref.version}`);
    }
    if (sha256Digest(artifact.canonicalJson) !== artifact.digest) {
      fail("digest_mismatch", `Stored artifact content is corrupt: ${ref.id}@${ref.version}`);
    }
    return artifact;
  }

  createTask(command: CreateTaskCommand): Task {
    return this.command("create_task", command, () => {
      validateActor(command.actor);
      requireText("taskId", command.taskId);
      requireText("goal", command.goal);
      this.requireArtifact(command.prd, "prd");
      const now = this.clock.now();
      try {
        this.database
          .prepare(`
            INSERT INTO tasks (
              task_id, version, status, goal, prd_id, prd_version, prd_digest, created_at, updated_at
            ) VALUES (?, 1, 'intake', ?, ?, ?, ?, ?, ?)
          `)
          .run(command.taskId, command.goal, command.prd.id, command.prd.version, command.prd.digest, now, now);
      } catch (error) {
        this.translateConstraint(error, `Task already exists: ${command.taskId}`);
      }
      this.insertTaskTransition({
        taskId: command.taskId,
        commandId: command.commandId,
        toStatus: "intake",
        toVersion: 1,
        actor: command.actor,
        reasonCode: "task_created",
        refs: [command.prd],
        evidenceRefs: [],
        occurredAt: now,
      });
      return this.requireTask(command.taskId);
    });
  }

  getTask(taskId: string): Task {
    return this.requireTask(taskId);
  }

  startContextualization(command: StartContextualizationCommand): Task {
    return this.command("start_contextualization", command, () => {
      const task = this.requireTask(command.taskId);
      this.assertTask(task, command.expectedTaskVersion, "intake");
      requireText("reason", command.reason);
      return this.writeTaskTransition(task, {
        status: "contextualizing",
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "contextualization_started",
        refs: [task.prd],
      });
    });
  }

  completeContextualization(command: CompleteContextualizationCommand): Task {
    return this.command("complete_contextualization", command, () => {
      const task = this.requireTask(command.taskId);
      this.assertTask(task, command.expectedTaskVersion, "contextualizing");
      this.requireArtifact(command.contextManifest, "context_manifest");
      return this.writeTaskTransition(task, {
        status: "drafting_trd",
        contextManifest: command.contextManifest,
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "context_sealed",
        refs: [task.prd, command.contextManifest],
        evidenceRefs: command.evidenceRefs,
      });
    });
  }

  submitTrdForApproval(command: SubmitTrdForApprovalCommand): { task: Task; approval: Approval } {
    return this.command("submit_trd_for_approval", command, () => {
      const task = this.requireTask(command.taskId);
      this.assertTask(task, command.expectedTaskVersion, "drafting_trd");
      this.requireArtifact(command.trd, "trd");
      const now = this.clock.now();
      const approval = this.insertApproval({
        approvalId: command.approvalId,
        taskId: task.taskId,
        gate: "trd_approval",
        subjectType: "trd",
        subject: command.trd,
        policyVersion: command.policyVersion,
        requiredRoles: command.requiredRoles,
        requestedBy: command.actor.actorId,
        ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
        commandId: command.commandId,
        actor: command.actor,
        now,
      });
      const updatedTask = this.writeTaskTransition(task, {
        status: "awaiting_trd_approval",
        trd: command.trd,
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "trd_submitted",
        refs: [task.prd, task.contextManifest!, command.trd],
      });
      this.insertOutbox("approval.requested", "approval", approval.approvalId, { approvalId: approval.approvalId }, now);
      return { task: updatedTask, approval };
    });
  }

  getApproval(approvalId: string): Approval {
    return this.requireApproval(approvalId);
  }

  recordApprovalDecision(command: RecordApprovalDecisionCommand): { approval: Approval; task: Task; run?: Run } {
    return this.command("record_approval_decision", command, () => this.applyApprovalDecision(command));
  }

  sealRunManifest(command: SealRunManifestCommand): { run: Run; approval: Approval; manifestDigest: string } {
    return this.command("seal_run_manifest", command, () => {
      const task = this.requireTask(command.taskId);
      this.assertTask(task, command.expectedTaskVersion, "planning");
      const normalized = normalizeRunManifest(command.manifest);
      this.validateManifest(task, command.runId, normalized);
      const canonicalJson = canonicalizeJson(normalized);
      const manifestDigest = sha256Digest(canonicalJson);
      const now = this.clock.now();
      const approval = this.insertApproval({
        approvalId: command.authorizationApprovalId,
        taskId: task.taskId,
        gate: "run_authorization",
        subjectType: "run_manifest",
        subject: { id: command.runId, version: "1", digest: manifestDigest },
        policyVersion: command.authorizationPolicyVersion,
        requiredRoles: command.requiredAuthorizationRoles,
        requestedBy: command.actor.actorId,
        ...(command.authorizationExpiresAt === undefined ? {} : { expiresAt: command.authorizationExpiresAt }),
        commandId: command.commandId,
        actor: command.actor,
        now,
      });
      try {
        this.database
          .prepare(`
            INSERT INTO runs (
              run_id, task_id, version, manifest_digest, authorization_approval_id, status, created_at, updated_at
            ) VALUES (?, ?, 1, ?, ?, 'awaiting_authorization', ?, ?)
          `)
          .run(command.runId, task.taskId, manifestDigest, approval.approvalId, now, now);
      } catch (error) {
        this.translateConstraint(error, `Task already has an unsettled Run: ${task.taskId}`);
      }
      this.database
        .prepare("INSERT INTO run_manifests (run_id, schema_version, digest, canonical_json, created_at) VALUES (?, '1', ?, ?, ?)")
        .run(command.runId, manifestDigest, canonicalJson, now);
      this.insertRunTransition({
        runId: command.runId,
        commandId: command.commandId,
        toStatus: "awaiting_authorization",
        toVersion: 1,
        actor: command.actor,
        reasonCode: "manifest_sealed",
        refs: [{ id: command.runId, version: "1", digest: manifestDigest }],
        evidenceRefs: [],
        occurredAt: now,
      });
      this.insertOutbox("approval.requested", "approval", approval.approvalId, { approvalId: approval.approvalId }, now);
      return { run: this.requireRun(command.runId), approval, manifestDigest };
    });
  }

  getRun(runId: string): Run {
    return this.requireRun(runId);
  }

  getRunManifest(runId: string): { manifest: RunManifestV1; canonicalJson: string; digest: string } {
    const row = this.database.prepare("SELECT * FROM run_manifests WHERE run_id = ?").get(runId) as SqlRow | undefined;
    if (row === undefined) {
      fail("not_found", `RunManifest not found: ${runId}`);
    }
    const canonicalJson = asText(row, "canonical_json");
    const digest = asText(row, "digest");
    if (sha256Digest(canonicalJson) !== digest) {
      fail("digest_mismatch", `Stored RunManifest is corrupt: ${runId}`);
    }
    return { manifest: parseJson<RunManifestV1>(canonicalJson), canonicalJson, digest };
  }

  // Role execution and completion commands are defined below to keep all state changes on this transaction boundary.

  prepareRoleRun(command: PrepareRoleRunCommand): RoleRun {
    return this.command("prepare_role_run", command, () => {
      const task = this.requireTask(command.taskId);
      const run = this.requireRun(command.runId);
      this.assertVersion("Task", task.version, command.expectedTaskVersion);
      this.assertVersion("Run", run.version, command.expectedRunVersion);
      if (run.taskId !== task.taskId || !["authorized", "active"].includes(run.status)) {
        fail("invalid_transition", `Run is not executable: ${run.runId}`);
      }
      const manifest = this.getRunManifest(run.runId).manifest;
      this.assertRunApprovalsEffective(run, manifest);
      const rolePlan = manifest.roles.find((candidate) => candidate.rolePlanId === command.rolePlanId);
      if (rolePlan === undefined) {
        fail("invalid_input", `RolePlan is not in RunManifest: ${command.rolePlanId}`);
      }
      if (
        (rolePlan.role === "executor" && task.status !== "executing") ||
        (rolePlan.role === "verifier" && task.status !== "verifying") ||
        rolePlan.role === "coordinator"
      ) {
        fail("invalid_transition", `Role ${rolePlan.role} cannot run while Task is ${task.status}`);
      }
      for (const ref of command.inputArtifacts) {
        this.requireArtifact(ref);
      }
      const countRow = this.database
        .prepare("SELECT count(*) AS count FROM role_runs WHERE run_id = ?")
        .get(run.runId) as SqlRow;
      const roleCountRow = this.database
        .prepare("SELECT count(*) AS count FROM role_runs WHERE run_id = ? AND role_plan_id = ?")
        .get(run.runId, rolePlan.rolePlanId) as SqlRow;
      const count = asNumber(countRow, "count");
      const roleCount = asNumber(roleCountRow, "count");
      if (count >= manifest.policies.maxRoleRuns || roleCount >= rolePlan.limits.maxAttempts) {
        fail("limit_exceeded", `RoleRun limit reached for Run: ${run.runId}`);
      }
      const now = this.clock.now();
      try {
        this.database
          .prepare(`
            INSERT INTO role_runs (
              role_run_id, run_id, role_plan_id, role, attempt, version, status,
              input_artifacts_json, output_artifacts_json, tool_operation_refs_json,
              evidence_refs_json, lease_token, prepared_at
            ) VALUES (?, ?, ?, ?, ?, 1, 'prepared', ?, '[]', '[]', '[]', 0, ?)
          `)
          .run(
            command.roleRunId,
            run.runId,
            rolePlan.rolePlanId,
            rolePlan.role,
            count + 1,
            canonicalizeJson(command.inputArtifacts),
            now,
          );
      } catch (error) {
        this.translateConstraint(error, `Run already has an unsettled RoleRun: ${run.runId}`);
      }
      this.insertRoleRunTransition({
        roleRunId: command.roleRunId,
        commandId: command.commandId,
        toStatus: "prepared",
        toVersion: 1,
        actor: command.actor,
        reasonCode: "role_run_prepared",
        refs: command.inputArtifacts,
        evidenceRefs: [],
        leaseToken: 0,
        occurredAt: now,
      });
      return this.requireRoleRun(command.roleRunId);
    });
  }

  getRoleRun(roleRunId: string): RoleRun {
    return this.requireRoleRun(roleRunId);
  }

  acquireRoleRunLease(command: AcquireRoleRunLeaseCommand): { roleRun: RoleRun; run: Run } {
    return this.command("acquire_role_run_lease", command, () => {
      const task = this.requireTask(command.taskId);
      const run = this.requireRun(command.runId);
      const roleRun = this.requireRoleRun(command.roleRunId);
      this.assertVersion("Task", task.version, command.expectedTaskVersion);
      this.assertVersion("Run", run.version, command.expectedRunVersion);
      this.assertVersion("RoleRun", roleRun.version, command.expectedRoleRunVersion);
      requireText("leaseOwner", command.leaseOwner);
      if (command.actor.actorType !== "worker" || command.actor.actorId !== command.leaseOwner) {
        fail("permission_denied", "Lease must be acquired by its worker owner");
      }
      requirePositiveInteger("leaseDurationMs", command.leaseDurationMs);
      if (command.leaseDurationMs > 86_400_000) {
        fail("invalid_input", "leaseDurationMs exceeds the v0.1 maximum");
      }
      if (run.taskId !== task.taskId || roleRun.runId !== run.runId) {
        fail("invalid_input", "Task, Run, and RoleRun do not belong to the same execution");
      }
      const now = this.clock.now();
      if (
        roleRun.status !== "prepared" &&
        !(roleRun.status === "starting" && roleRun.sessionId === undefined && roleRun.leaseExpiresAt !== undefined && roleRun.leaseExpiresAt <= now)
      ) {
        fail("invalid_transition", `RoleRun lease cannot be acquired from ${roleRun.status}`);
      }
      const expiresAt = new Date(Date.parse(now) + command.leaseDurationMs).toISOString();
      const updatedRoleRun = this.writeRoleRunTransition(roleRun, {
        status: "starting",
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: roleRun.status === "prepared" ? "lease_acquired" : "lease_reacquired",
        leaseOwner: command.leaseOwner,
        leaseExpiresAt: expiresAt,
        leaseToken: roleRun.leaseToken + 1,
        startedAt: roleRun.startedAt ?? now,
      });
      const updatedRun =
        run.status === "authorized"
          ? this.writeRunTransition(run, {
              status: "active",
              actor: command.actor,
              commandId: command.commandId,
              reasonCode: "first_role_started",
              refs: [],
              evidenceRefs: [],
            })
          : run;
      if (updatedRun.status !== "active") {
        fail("invalid_transition", `Run is not active: ${updatedRun.runId}`);
      }
      return { roleRun: updatedRoleRun, run: updatedRun };
    });
  }

  markRoleRunRunning(command: MarkRoleRunRunningCommand): RoleRun {
    return this.command("mark_role_run_running", command, () => {
      const roleRun = this.requireRoleRun(command.roleRunId);
      this.assertRoleLease(roleRun, command.expectedRoleRunVersion, command.leaseToken, "starting", command.actor);
      requireText("sessionId", command.sessionId);
      return this.writeRoleRunTransition(roleRun, {
        status: "running",
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "runtime_session_started",
        sessionId: command.sessionId,
        leaseToken: command.leaseToken,
      });
    });
  }

  markRoleRunSettling(command: MarkRoleRunSettlingCommand): RoleRun {
    return this.command("mark_role_run_settling", command, () => {
      const roleRun = this.requireRoleRun(command.roleRunId);
      this.assertRoleLease(roleRun, command.expectedRoleRunVersion, command.leaseToken, "running", command.actor);
      const now = this.clock.now();
      return this.writeRoleRunTransition(roleRun, {
        status: "settling",
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "runtime_ended",
        runtimeOutcome: command.runtimeOutcome,
        toolOperationRefs: uniqueSorted(command.toolOperationRefs, "Tool Operation ref"),
        runtimeEndedAt: now,
        leaseToken: command.leaseToken,
      });
    });
  }

  settleRoleRun(command: SettleRoleRunCommand): RoleRun {
    return this.command("settle_role_run", command, () => {
      const roleRun = this.requireRoleRun(command.roleRunId);
      this.assertRoleLease(roleRun, command.expectedRoleRunVersion, command.leaseToken, "settling", command.actor);
      requireText("errorCode", command.errorCode);
      requireText("sanitizedError", command.sanitizedError);
      return this.writeRoleRunTransition(roleRun, {
        status: "settled",
        outcome: command.outcome,
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "role_run_unsuccessful",
        evidenceRefs: command.evidenceRefs,
        errorCode: command.errorCode,
        sanitizedError: command.sanitizedError,
        settledAt: this.clock.now(),
        leaseToken: command.leaseToken,
        clearLease: true,
      });
    });
  }

  submitExecutionForVerification(command: SubmitExecutionForVerificationCommand): { task: Task; roleRun: RoleRun; executionResult: Artifact } {
    return this.command("submit_execution_for_verification", command, () => {
      const task = this.requireTask(command.taskId);
      const run = this.requireRun(command.runId);
      const roleRun = this.requireRoleRun(command.roleRunId);
      this.assertTask(task, command.expectedTaskVersion, "executing");
      this.assertRun(run, command.expectedRunVersion, "active");
      this.assertRoleLease(roleRun, command.expectedRoleRunVersion, command.leaseToken, "settling", command.actor);
      if (roleRun.runId !== run.runId || roleRun.role !== "executor" || roleRun.runtimeOutcome !== "completed") {
        fail("invalid_transition", "Executor RoleRun is not ready for verification handoff");
      }
      this.assertRunApprovalsEffective(run, this.getRunManifest(run.runId).manifest);
      if (canonicalizeJson(uniqueSorted(command.toolOperationRefs, "Tool Operation ref")) !== canonicalizeJson(roleRun.toolOperationRefs)) {
        fail("invalid_input", "Execution Tool Operation refs do not match the settled runtime record");
      }
      const executionResult = this.insertArtifact(command.executionResult, this.clock.now(), "execution_result");
      this.assertExecutionResultBinding(executionResult, task, run);
      const updatedRoleRun = this.writeRoleRunTransition(roleRun, {
        status: "settled",
        outcome: "succeeded",
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "execution_submitted",
        outputArtifacts: [executionResult],
        evidenceRefs: command.evidenceRefs,
        settledAt: this.clock.now(),
        leaseToken: command.leaseToken,
        clearLease: true,
      });
      const updatedTask = this.writeTaskTransition(task, {
        status: "verifying",
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "execution_ready_for_verification",
        refs: [executionResult],
        evidenceRefs: command.evidenceRefs,
      });
      return { task: updatedTask, roleRun: updatedRoleRun, executionResult };
    });
  }

  submitVerificationResult(command: SubmitVerificationResultCommand): { task: Task; run: Run; roleRun: RoleRun; verificationResult: Artifact } {
    return this.command("submit_verification_result", command, () => {
      const task = this.requireTask(command.taskId);
      const run = this.requireRun(command.runId);
      const roleRun = this.requireRoleRun(command.roleRunId);
      this.assertTask(task, command.expectedTaskVersion, "verifying");
      this.assertRun(run, command.expectedRunVersion, "active");
      this.assertRoleLease(roleRun, command.expectedRoleRunVersion, command.leaseToken, "settling", command.actor);
      this.requireArtifact(command.executionResult, "execution_result");
      if (roleRun.runId !== run.runId || roleRun.role !== "verifier" || roleRun.runtimeOutcome !== "completed") {
        fail("invalid_transition", "Verifier RoleRun is not ready to submit a result");
      }
      this.assertRunApprovalsEffective(run, this.getRunManifest(run.runId).manifest);
      if (!roleRun.inputArtifacts.some((ref) => this.sameRef(ref, command.executionResult))) {
        fail("invalid_input", "Verifier did not receive the submitted ExecutionResult");
      }
      this.validateVerificationRouting(command.verdict, command.findingClass);
      const verificationResult = this.insertArtifact(command.verificationResult, this.clock.now(), "verification_result");
      this.assertVerificationResultBinding(
        verificationResult,
        task,
        run,
        command.executionResult,
        command.verdict,
        command.findingClass,
      );
      const updatedRoleRun = this.writeRoleRunTransition(roleRun, {
        status: "settled",
        outcome: "succeeded",
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: `verification_${command.verdict}`,
        outputArtifacts: [verificationResult],
        evidenceRefs: command.evidenceRefs,
        settledAt: this.clock.now(),
        leaseToken: command.leaseToken,
        clearLease: true,
      });

      if (command.verdict === "pass") {
        const updatedTask = this.writeTaskTransition(task, {
          status: "awaiting_acceptance",
          actor: command.actor,
          commandId: command.commandId,
          reasonCode: "verification_passed",
          refs: [command.executionResult, verificationResult],
          evidenceRefs: command.evidenceRefs,
        });
        return { task: updatedTask, run, roleRun: updatedRoleRun, verificationResult };
      }
      if (command.verdict === "fail" && command.findingClass === "implementation") {
        const updatedTask = this.writeTaskTransition(task, {
          status: "executing",
          actor: command.actor,
          commandId: command.commandId,
          reasonCode: command.reasonCode,
          refs: [command.executionResult, verificationResult],
          evidenceRefs: command.evidenceRefs,
        });
        return { task: updatedTask, run, roleRun: updatedRoleRun, verificationResult };
      }
      if (command.verdict === "blocked") {
        const updatedTask = this.writeTaskTransition(task, {
          status: "blocked",
          blockedReason: command.reasonCode,
          resumeToStatus: "verifying",
          actor: command.actor,
          commandId: command.commandId,
          reasonCode: command.reasonCode,
          refs: [command.executionResult, verificationResult],
          evidenceRefs: command.evidenceRefs,
        });
        const updatedRun = this.writeRunTransition(run, {
          status: "blocked",
          resumeToStatus: "active",
          reasonCode: command.reasonCode,
          actor: command.actor,
          commandId: command.commandId,
          refs: [verificationResult],
          evidenceRefs: command.evidenceRefs,
        });
        return { task: updatedTask, run: updatedRun, roleRun: updatedRoleRun, verificationResult };
      }

      const upstream = this.upstreamForFinding(command.findingClass!);
      const updatedTask = this.writeTaskTransition(task, {
        status: "blocked",
        blockedReason: command.reasonCode,
        resumeToStatus: upstream,
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: command.reasonCode,
        refs: [command.executionResult, verificationResult],
        evidenceRefs: command.evidenceRefs,
      });
      const updatedRun = this.writeRunTransition(run, {
        status: "stopping",
        pendingOutcome: "superseded",
        reasonCode: command.reasonCode,
        actor: command.actor,
        commandId: command.commandId,
        refs: [verificationResult],
        evidenceRefs: command.evidenceRefs,
      });
      return { task: updatedTask, run: updatedRun, roleRun: updatedRoleRun, verificationResult };
    });
  }

  requestAcceptanceRework(command: RequestAcceptanceReworkCommand): { task: Task; run: Run; acceptanceFeedback: Artifact } {
    return this.command("request_acceptance_rework", command, () => {
      const task = this.requireTask(command.taskId);
      const run = this.requireRun(command.runId);
      this.assertTask(task, command.expectedTaskVersion, "awaiting_acceptance");
      this.assertRun(run, command.expectedRunVersion, "active");
      this.requireHuman(command.actor);
      this.assertRunApprovalsEffective(run, this.getRunManifest(run.runId).manifest);
      const executionResult = this.requireArtifact(command.executionResult, "execution_result");
      this.assertExecutionResultBinding(executionResult, task, run);
      this.requirePassingVerification(command.verificationResult, task, run, command.executionResult);
      const feedback = this.insertArtifact(command.acceptanceFeedback, this.clock.now(), "acceptance_feedback");
      if (command.findingClass === "implementation") {
        const updatedTask = this.writeTaskTransition(task, {
          status: "executing",
          actor: command.actor,
          commandId: command.commandId,
          reasonCode: command.reasonCode,
          refs: [command.executionResult, command.verificationResult, feedback],
        });
        return { task: updatedTask, run, acceptanceFeedback: feedback };
      }
      if (command.findingClass === undefined) {
        const updatedTask = this.writeTaskTransition(task, {
          status: "blocked",
          blockedReason: command.reasonCode,
          resumeToStatus: "awaiting_acceptance",
          actor: command.actor,
          commandId: command.commandId,
          reasonCode: command.reasonCode,
          refs: [feedback],
        });
        const updatedRun = this.writeRunTransition(run, {
          status: "blocked",
          resumeToStatus: "active",
          reasonCode: command.reasonCode,
          actor: command.actor,
          commandId: command.commandId,
          refs: [feedback],
          evidenceRefs: [],
        });
        return { task: updatedTask, run: updatedRun, acceptanceFeedback: feedback };
      }
      const upstream = this.upstreamForFinding(command.findingClass);
      const updatedTask = this.writeTaskTransition(task, {
        status: "blocked",
        blockedReason: command.reasonCode,
        resumeToStatus: upstream,
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: command.reasonCode,
        refs: [feedback],
      });
      const updatedRun = this.writeRunTransition(run, {
        status: "stopping",
        pendingOutcome: "superseded",
        reasonCode: command.reasonCode,
        actor: command.actor,
        commandId: command.commandId,
        refs: [feedback],
        evidenceRefs: [],
      });
      return { task: updatedTask, run: updatedRun, acceptanceFeedback: feedback };
    });
  }

  acceptDelivery(command: AcceptDeliveryCommand): { task: Task; run: Run } {
    return this.command("accept_delivery", command, () => {
      const task = this.requireTask(command.taskId);
      const run = this.requireRun(command.runId);
      this.assertTask(task, command.expectedTaskVersion, "awaiting_acceptance");
      this.assertRun(run, command.expectedRunVersion, "active");
      this.requireHuman(command.actor);
      this.assertRunApprovalsEffective(run, this.getRunManifest(run.runId).manifest);
      if (!command.actor.roles.includes("delivery_authority")) {
        fail("permission_denied", "Final acceptance requires delivery_authority role");
      }
      const executionResult = this.requireArtifact(command.executionResult, "execution_result");
      this.assertExecutionResultBinding(executionResult, task, run);
      this.requirePassingVerification(command.verificationResult, task, run, command.executionResult);
      requireText("reason", command.reason);
      if (this.unsettledRoleRun(run.runId) !== undefined) {
        fail("invalid_transition", "Delivery cannot be accepted while a RoleRun is unsettled");
      }
      const now = this.clock.now();
      const updatedTask = this.writeTaskTransition(task, {
        status: "closed",
        outcome: "completed",
        closedAt: now,
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "delivery_accepted",
        refs: [command.executionResult, command.verificationResult],
        evidenceRefs: command.evidenceRefs,
      });
      const updatedRun = this.writeRunTransition(run, {
        status: "settled",
        outcome: "completed",
        settledAt: now,
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "delivery_accepted",
        refs: [command.executionResult, command.verificationResult],
        evidenceRefs: command.evidenceRefs,
      });
      this.insertOutbox("evidence.export_requested", "task", task.taskId, { taskId: task.taskId, runId: run.runId }, now);
      return { task: updatedTask, run: updatedRun };
    });
  }

  cancelTask(command: CancelTaskCommand): { task: Task; run?: Run } {
    return this.command("cancel_task", command, () => this.applyCancellation(command));
  }

  finishRunStop(command: FinishRunStopCommand): { task: Task; run: Run } {
    return this.command("finish_run_stop", command, () => this.applyFinishRunStop(command));
  }

  invalidateApproval(command: InvalidateApprovalCommand): { approval: Approval; task: Task; run?: Run } {
    return this.command("invalidate_approval", command, () => this.applyApprovalInvalidation(command));
  }

  markOutboxDelivered(command: MarkOutboxDeliveredCommand): void {
    this.command("mark_outbox_delivered", command, () => {
      const row = this.database.prepare("SELECT status FROM outbox WHERE event_id = ?").get(command.eventId) as SqlRow | undefined;
      if (row === undefined) {
        fail("not_found", `Outbox event not found: ${command.eventId}`);
      }
      if (asText(row, "status") === "pending") {
        this.database
          .prepare("UPDATE outbox SET status = 'delivered', delivered_at = ? WHERE event_id = ? AND status = 'pending'")
          .run(this.clock.now(), command.eventId);
      }
      return null;
    });
  }

  planRecovery(): RecoveryAction[] {
    const actions: RecoveryAction[] = [];
    const outboxRows = this.database.prepare("SELECT event_id FROM outbox WHERE status = 'pending' ORDER BY event_id").all() as SqlRow[];
    for (const row of outboxRows) {
      const eventId = asText(row, "event_id");
      actions.push({ actionId: `outbox:${eventId}`, kind: "deliver_outbox", refId: eventId });
    }
    const roleRows = this.database
      .prepare("SELECT rr.*, r.task_id FROM role_runs rr JOIN runs r ON r.run_id = rr.run_id WHERE rr.status <> 'settled' ORDER BY rr.role_run_id")
      .all() as SqlRow[];
    for (const row of roleRows) {
      const roleRun = roleRunFromRow(row);
      const taskId = asText(row, "task_id");
      const base = { taskId, runId: roleRun.runId, roleRunId: roleRun.roleRunId };
      if (
        roleRun.status === "prepared" ||
        (roleRun.status === "starting" &&
          roleRun.sessionId === undefined &&
          roleRun.leaseExpiresAt !== undefined &&
          roleRun.leaseExpiresAt <= this.clock.now())
      ) {
        actions.push({ actionId: `role:start:${roleRun.roleRunId}`, kind: "start_role_run", ...base });
      } else if (roleRun.status === "running") {
        actions.push({ actionId: `role:interrupt:${roleRun.roleRunId}`, kind: "interrupt_lost_session", ...base });
      } else if (roleRun.status === "settling") {
        actions.push({ actionId: `role:settle:${roleRun.roleRunId}`, kind: "continue_settlement", ...base });
      } else if (roleRun.status === "blocked") {
        actions.push({ actionId: `role:blocked:${roleRun.roleRunId}`, kind: "await_manual_resolution", ...base });
      }
    }
    const stoppingRows = this.database.prepare("SELECT run_id, task_id FROM runs WHERE status = 'stopping' ORDER BY run_id").all() as SqlRow[];
    for (const row of stoppingRows) {
      const runId = asText(row, "run_id");
      actions.push({ actionId: `run:stop:${runId}`, kind: "continue_stop", runId, taskId: asText(row, "task_id") });
    }
    return actions;
  }

  listTaskTransitions(taskId: string): StoredTransition[] {
    return this.readTransitions("task_transitions", "task_id", taskId);
  }

  listRunTransitions(runId: string): StoredTransition[] {
    return this.readTransitions("run_transitions", "run_id", runId);
  }

  listRoleRunTransitions(roleRunId: string): StoredTransition[] {
    return this.readTransitions("role_run_transitions", "role_run_id", roleRunId, true);
  }

  getApprovalRef(approvalId: string): VersionedRef {
    const approval = this.requireApproval(approvalId);
    return {
      id: approval.approvalId,
      version: String(approval.version),
      digest: digestJson(approval),
    };
  }

  private command<T>(
    commandType: string,
    request: { commandId: string; actor: Actor },
    action: () => T,
  ): T {
    requireText("commandId", request.commandId);
    validateActor(request.actor);
    const requestDigest = digestJson({ commandType, request });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare("SELECT request_digest, result_json FROM commands WHERE command_id = ?")
        .get(request.commandId) as SqlRow | undefined;
      if (existing !== undefined) {
        if (asText(existing, "request_digest") !== requestDigest) {
          fail("command_conflict", `Command ID was already used with different input: ${request.commandId}`);
        }
        const result = parseJson<T>(asText(existing, "result_json"));
        this.database.exec("COMMIT");
        return result;
      }

      const result = action();
      const resultJson = canonicalizeJson(result);
      this.database
        .prepare("INSERT INTO commands (command_id, command_type, request_digest, result_json, completed_at) VALUES (?, ?, ?, ?, ?)")
        .run(request.commandId, commandType, requestDigest, resultJson, this.clock.now());
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // The original error is more useful when SQLite already rolled back the transaction.
      }
      throw error;
    }
  }

  private artifactFromRow(row: SqlRow): Artifact {
    const canonicalJson = asText(row, "canonical_json");
    return {
      id: asText(row, "artifact_id"),
      version: asText(row, "artifact_version"),
      kind: asText(row, "kind"),
      digest: asText(row, "digest"),
      content: parseJson<JsonValue>(canonicalJson),
      canonicalJson,
      createdBy: asText(row, "created_by"),
      createdAt: asText(row, "created_at"),
    };
  }

  private insertArtifact(input: ArtifactInput, now: string, expectedKind?: string): Artifact {
    requireText("artifact id", input.id);
    requireText("artifact version", input.version);
    requireText("artifact kind", input.kind);
    requireText("artifact createdBy", input.createdBy);
    if (expectedKind !== undefined && input.kind !== expectedKind) {
      fail("invalid_input", `Expected ${expectedKind} artifact, received ${input.kind}`);
    }
    const canonicalJson = canonicalizeJson(input.content);
    const digest = sha256Digest(canonicalJson);
    if (input.digest !== digest) {
      fail("digest_mismatch", `Artifact digest does not match content: ${input.id}@${input.version}`);
    }
    const existing = this.database
      .prepare("SELECT * FROM artifacts WHERE artifact_id = ? AND artifact_version = ?")
      .get(input.id, input.version) as SqlRow | undefined;
    if (existing !== undefined) {
      const artifact = this.artifactFromRow(existing);
      if (artifact.digest !== digest || artifact.kind !== input.kind || artifact.createdBy !== input.createdBy) {
        fail("already_exists", `Artifact version already exists with different content: ${input.id}@${input.version}`);
      }
      return artifact;
    }
    this.database
      .prepare(`
        INSERT INTO artifacts (
          artifact_id, artifact_version, kind, digest, canonical_json, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(input.id, input.version, input.kind, digest, canonicalJson, input.createdBy, now);
    return this.artifactFromRow(
      this.database
        .prepare("SELECT * FROM artifacts WHERE artifact_id = ? AND artifact_version = ?")
        .get(input.id, input.version) as SqlRow,
    );
  }

  private requireArtifact(ref: VersionedRef, expectedKind?: string): Artifact {
    const artifact = this.getArtifact(ref);
    if (expectedKind !== undefined && artifact.kind !== expectedKind) {
      fail("invalid_input", `Expected ${expectedKind} artifact, received ${artifact.kind}`);
    }
    return artifact;
  }

  private requireTask(taskId: string): Task {
    const row = this.database.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as SqlRow | undefined;
    if (row === undefined) {
      fail("not_found", `Task not found: ${taskId}`);
    }
    return taskFromRow(row);
  }

  private requireApproval(approvalId: string): Approval {
    const row = this.database.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(approvalId) as SqlRow | undefined;
    if (row === undefined) {
      fail("not_found", `Approval not found: ${approvalId}`);
    }
    return approvalFromRow(row);
  }

  private requireRun(runId: string): Run {
    const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as SqlRow | undefined;
    if (row === undefined) {
      fail("not_found", `Run not found: ${runId}`);
    }
    return runFromRow(row);
  }

  private requireRoleRun(roleRunId: string): RoleRun {
    const row = this.database.prepare("SELECT * FROM role_runs WHERE role_run_id = ?").get(roleRunId) as SqlRow | undefined;
    if (row === undefined) {
      fail("not_found", `RoleRun not found: ${roleRunId}`);
    }
    return roleRunFromRow(row);
  }

  private assertVersion(label: string, actual: number, expected: number): void {
    requirePositiveInteger(`expected${label}Version`, expected);
    if (actual !== expected) {
      fail("version_conflict", `${label} version conflict: expected ${expected}, actual ${actual}`);
    }
  }

  private assertTask(task: Task, expectedVersion: number, expectedStatus: TaskStatus): void {
    this.assertVersion("Task", task.version, expectedVersion);
    if (task.status !== expectedStatus) {
      fail("invalid_transition", `Task ${task.taskId} must be ${expectedStatus}, actual ${task.status}`);
    }
  }

  private assertRun(run: Run, expectedVersion: number, expectedStatus: Run["status"]): void {
    this.assertVersion("Run", run.version, expectedVersion);
    if (run.status !== expectedStatus) {
      fail("invalid_transition", `Run ${run.runId} must be ${expectedStatus}, actual ${run.status}`);
    }
  }

  private assertRoleLease(
    roleRun: RoleRun,
    expectedVersion: number,
    leaseToken: number,
    expectedStatus: RoleRunStatus,
    actor?: Actor,
  ): void {
    this.assertVersion("RoleRun", roleRun.version, expectedVersion);
    if (roleRun.status !== expectedStatus) {
      fail("invalid_transition", `RoleRun ${roleRun.roleRunId} must be ${expectedStatus}, actual ${roleRun.status}`);
    }
    if (leaseToken <= 0 || roleRun.leaseToken !== leaseToken) {
      fail("fencing_rejected", `Stale fencing token for RoleRun: ${roleRun.roleRunId}`);
    }
    if (actor !== undefined && (actor.actorType !== "worker" || actor.actorId !== roleRun.leaseOwner)) {
      fail("permission_denied", `Only the current lease owner can update RoleRun: ${roleRun.roleRunId}`);
    }
    if (roleRun.leaseExpiresAt === undefined || roleRun.leaseExpiresAt <= this.clock.now()) {
      fail("fencing_rejected", `RoleRun lease has expired: ${roleRun.roleRunId}`);
    }
  }

  private requireHuman(actor: Actor): void {
    if (actor.actorType !== "human") {
      fail("permission_denied", "This command requires a Human Authority");
    }
  }

  private writeTaskTransition(task: Task, change: TaskChange): Task {
    validateActor(change.actor);
    const version = task.version + 1;
    const now = this.clock.now();
    const context = change.contextManifest ?? task.contextManifest;
    const trd = change.trd ?? task.trd;
    const blocked = change.status === "blocked";
    const closed = change.status === "closed";
    if (blocked && (change.blockedReason === undefined || change.resumeToStatus === undefined)) {
      fail("invalid_input", "Blocked Task requires reason and resumeToStatus");
    }
    if (closed && (change.outcome === undefined || change.closedAt === undefined)) {
      fail("invalid_input", "Closed Task requires outcome and closedAt");
    }
    const result = this.database
      .prepare(`
        UPDATE tasks SET
          version = ?, status = ?, outcome = ?,
          context_id = ?, context_version = ?, context_digest = ?,
          trd_id = ?, trd_version = ?, trd_digest = ?,
          blocked_reason = ?, resume_to_status = ?, updated_at = ?, closed_at = ?
        WHERE task_id = ? AND version = ?
      `)
      .run(
        version,
        change.status,
        closed ? change.outcome! : null,
        context?.id ?? null,
        context?.version ?? null,
        context?.digest ?? null,
        trd?.id ?? null,
        trd?.version ?? null,
        trd?.digest ?? null,
        blocked ? change.blockedReason! : null,
        blocked ? change.resumeToStatus! : null,
        now,
        closed ? change.closedAt! : null,
        task.taskId,
        task.version,
      );
    if (result.changes !== 1) {
      fail("version_conflict", `Task changed while command was running: ${task.taskId}`);
    }
    this.insertTaskTransition({
      taskId: task.taskId,
      commandId: change.commandId,
      fromStatus: task.status,
      toStatus: change.status,
      fromVersion: task.version,
      toVersion: version,
      actor: change.actor,
      reasonCode: change.reasonCode,
      refs: change.refs,
      evidenceRefs: change.evidenceRefs ?? [],
      occurredAt: now,
    });
    return this.requireTask(task.taskId);
  }

  private writeRunTransition(run: Run, change: RunChange): Run {
    validateActor(change.actor);
    const version = run.version + 1;
    const now = this.clock.now();
    const stopping = change.status === "stopping";
    const blocked = change.status === "blocked";
    const settled = change.status === "settled";
    if (stopping && change.pendingOutcome === undefined) {
      fail("invalid_input", "Stopping Run requires pendingOutcome");
    }
    if (blocked && change.resumeToStatus === undefined) {
      fail("invalid_input", "Blocked Run requires resumeToStatus");
    }
    if (settled && (change.outcome === undefined || change.settledAt === undefined)) {
      fail("invalid_input", "Settled Run requires outcome and settledAt");
    }
    const result = this.database
      .prepare(`
        UPDATE runs SET
          version = ?, status = ?, outcome = ?, pending_outcome = ?, resume_to_status = ?,
          reason_code = ?, updated_at = ?, settled_at = ?
        WHERE run_id = ? AND version = ?
      `)
      .run(
        version,
        change.status,
        settled ? change.outcome! : null,
        stopping ? change.pendingOutcome! : null,
        blocked ? change.resumeToStatus! : null,
        stopping || blocked ? change.reasonCode : null,
        now,
        settled ? change.settledAt! : null,
        run.runId,
        run.version,
      );
    if (result.changes !== 1) {
      fail("version_conflict", `Run changed while command was running: ${run.runId}`);
    }
    this.insertRunTransition({
      runId: run.runId,
      commandId: change.commandId,
      fromStatus: run.status,
      toStatus: change.status,
      fromVersion: run.version,
      toVersion: version,
      actor: change.actor,
      reasonCode: change.reasonCode,
      refs: change.refs,
      evidenceRefs: change.evidenceRefs,
      occurredAt: now,
    });
    return this.requireRun(run.runId);
  }

  private writeRoleRunTransition(roleRun: RoleRun, change: RoleRunChange): RoleRun {
    validateActor(change.actor);
    const version = roleRun.version + 1;
    const now = this.clock.now();
    const settled = change.status === "settled";
    if (settled && (change.outcome === undefined || change.settledAt === undefined)) {
      fail("invalid_input", "Settled RoleRun requires outcome and settledAt");
    }
    const outputArtifacts = change.outputArtifacts ?? roleRun.outputArtifacts;
    const toolOperationRefs = change.toolOperationRefs ?? roleRun.toolOperationRefs;
    const evidenceRefs = change.evidenceRefs ?? roleRun.evidenceRefs;
    const clearLease = change.clearLease ?? false;
    const result = this.database
      .prepare(`
        UPDATE role_runs SET
          version = ?, status = ?, outcome = ?, runtime_outcome = ?, session_id = ?,
          output_artifacts_json = ?, tool_operation_refs_json = ?, evidence_refs_json = ?,
          lease_owner = ?, lease_expires_at = ?, lease_token = ?, started_at = ?,
          runtime_ended_at = ?, settled_at = ?, error_code = ?, sanitized_error = ?
        WHERE role_run_id = ? AND version = ? AND lease_token = ?
      `)
      .run(
        version,
        change.status,
        settled ? change.outcome! : null,
        change.runtimeOutcome ?? roleRun.runtimeOutcome ?? null,
        change.sessionId ?? roleRun.sessionId ?? null,
        canonicalizeJson(outputArtifacts.map((ref) => this.cleanRef(ref))),
        canonicalizeJson(uniqueSorted(toolOperationRefs, "Tool Operation ref")),
        canonicalizeJson(uniqueSorted(evidenceRefs, "evidence ref")),
        clearLease ? null : (change.leaseOwner ?? roleRun.leaseOwner ?? null),
        clearLease ? null : (change.leaseExpiresAt ?? roleRun.leaseExpiresAt ?? null),
        change.leaseToken,
        change.startedAt ?? roleRun.startedAt ?? null,
        change.runtimeEndedAt ?? roleRun.runtimeEndedAt ?? null,
        settled ? change.settledAt! : null,
        change.errorCode ?? roleRun.errorCode ?? null,
        change.sanitizedError ?? roleRun.sanitizedError ?? null,
        roleRun.roleRunId,
        roleRun.version,
        roleRun.leaseToken,
      );
    if (result.changes !== 1) {
      fail("fencing_rejected", `RoleRun version or fencing token changed: ${roleRun.roleRunId}`);
    }
    this.insertRoleRunTransition({
      roleRunId: roleRun.roleRunId,
      commandId: change.commandId,
      fromStatus: roleRun.status,
      toStatus: change.status,
      fromVersion: roleRun.version,
      toVersion: version,
      actor: change.actor,
      reasonCode: change.reasonCode,
      refs: outputArtifacts,
      evidenceRefs,
      leaseToken: change.leaseToken,
      occurredAt: now,
    });
    return this.requireRoleRun(roleRun.roleRunId);
  }

  private insertTaskTransition(input: InitialTransition & { taskId: string; fromStatus?: string; fromVersion?: number }): void {
    this.database
      .prepare(`
        INSERT INTO task_transitions (
          transition_id, task_id, command_id, from_status, to_status, from_version, to_version,
          actor_id, actor_type, actor_roles_json, reason_code, refs_json, evidence_refs_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        this.ids.next("task_transition"),
        input.taskId,
        input.commandId,
        input.fromStatus ?? null,
        input.toStatus,
        input.fromVersion ?? null,
        input.toVersion,
        input.actor.actorId,
        input.actor.actorType,
        canonicalizeJson(uniqueSorted(input.actor.roles, "actor role")),
        input.reasonCode,
        canonicalizeJson(input.refs.map((ref) => this.cleanRef(ref))),
        canonicalizeJson(uniqueSorted(input.evidenceRefs, "evidence ref")),
        input.occurredAt,
      );
  }

  private insertRunTransition(input: InitialTransition & { runId: string; fromStatus?: string; fromVersion?: number }): void {
    this.database
      .prepare(`
        INSERT INTO run_transitions (
          transition_id, run_id, command_id, from_status, to_status, from_version, to_version,
          actor_id, actor_type, actor_roles_json, reason_code, refs_json, evidence_refs_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        this.ids.next("run_transition"),
        input.runId,
        input.commandId,
        input.fromStatus ?? null,
        input.toStatus,
        input.fromVersion ?? null,
        input.toVersion,
        input.actor.actorId,
        input.actor.actorType,
        canonicalizeJson(uniqueSorted(input.actor.roles, "actor role")),
        input.reasonCode,
        canonicalizeJson(input.refs.map((ref) => this.cleanRef(ref))),
        canonicalizeJson(uniqueSorted(input.evidenceRefs, "evidence ref")),
        input.occurredAt,
      );
  }

  private insertRoleRunTransition(
    input: InitialTransition & { roleRunId: string; fromStatus?: string; fromVersion?: number; leaseToken: number },
  ): void {
    this.database
      .prepare(`
        INSERT INTO role_run_transitions (
          transition_id, role_run_id, command_id, from_status, to_status, from_version, to_version,
          actor_id, actor_type, actor_roles_json, reason_code, refs_json, evidence_refs_json, lease_token, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        this.ids.next("role_run_transition"),
        input.roleRunId,
        input.commandId,
        input.fromStatus ?? null,
        input.toStatus,
        input.fromVersion ?? null,
        input.toVersion,
        input.actor.actorId,
        input.actor.actorType,
        canonicalizeJson(uniqueSorted(input.actor.roles, "actor role")),
        input.reasonCode,
        canonicalizeJson(input.refs.map((ref) => this.cleanRef(ref))),
        canonicalizeJson(uniqueSorted(input.evidenceRefs, "evidence ref")),
        input.leaseToken,
        input.occurredAt,
      );
  }

  private insertApproval(input: ApprovalCreation): Approval {
    requireText("approvalId", input.approvalId);
    requireText("approval policyVersion", input.policyVersion);
    const requiredRoles = uniqueSorted(input.requiredRoles, "required approval role");
    if (requiredRoles.length === 0) {
      fail("invalid_input", "Approval requires at least one authority role");
    }
    if (input.expiresAt !== undefined) {
      if (!Number.isFinite(Date.parse(input.expiresAt)) || input.expiresAt <= input.now) {
        fail("invalid_input", "Approval expiry must be a future ISO timestamp");
      }
    }
    try {
      this.database
        .prepare(`
          INSERT INTO approvals (
            approval_id, task_id, version, gate_type, subject_type, subject_id, subject_version,
            subject_digest, policy_version, required_roles_json, requested_by, status,
            expires_at, created_at, updated_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `)
        .run(
          input.approvalId,
          input.taskId,
          input.gate,
          input.subjectType,
          input.subject.id,
          input.subject.version,
          input.subject.digest,
          input.policyVersion,
          canonicalizeJson(requiredRoles),
          input.requestedBy,
          input.expiresAt ?? null,
          input.now,
          input.now,
        );
    } catch (error) {
      this.translateConstraint(error, `Approval already exists or subject already has a pending request: ${input.approvalId}`);
    }
    this.insertApprovalTransition({
      approvalId: input.approvalId,
      commandId: input.commandId,
      toStatus: "pending",
      toVersion: 1,
      actor: input.actor,
      reasonCode: "approval_requested",
      refs: [input.subject],
      evidenceRefs: [],
      occurredAt: input.now,
    });
    return this.requireApproval(input.approvalId);
  }

  private insertApprovalTransition(
    input: InitialTransition & { approvalId: string; fromStatus?: string; fromVersion?: number },
  ): void {
    this.database
      .prepare(`
        INSERT INTO approval_transitions (
          transition_id, approval_id, command_id, from_status, to_status, from_version, to_version,
          actor_id, actor_type, actor_roles_json, reason_code, refs_json, evidence_refs_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        this.ids.next("approval_transition"),
        input.approvalId,
        input.commandId,
        input.fromStatus ?? null,
        input.toStatus,
        input.fromVersion ?? null,
        input.toVersion,
        input.actor.actorId,
        input.actor.actorType,
        canonicalizeJson(uniqueSorted(input.actor.roles, "actor role")),
        input.reasonCode,
        canonicalizeJson(input.refs.map((ref) => this.cleanRef(ref))),
        canonicalizeJson(uniqueSorted(input.evidenceRefs, "evidence ref")),
        input.occurredAt,
      );
  }

  private writeApprovalTransition(
    approval: Approval,
    status: ApprovalStatus,
    command: { commandId: string; actor: Actor; reasonCode: string; evidenceRefs: readonly string[] },
  ): Approval {
    const version = approval.version + 1;
    const now = this.clock.now();
    const result = this.database
      .prepare("UPDATE approvals SET version = ?, status = ?, updated_at = ? WHERE approval_id = ? AND version = ?")
      .run(version, status, now, approval.approvalId, approval.version);
    if (result.changes !== 1) {
      fail("version_conflict", `Approval changed while command was running: ${approval.approvalId}`);
    }
    this.insertApprovalTransition({
      approvalId: approval.approvalId,
      commandId: command.commandId,
      fromStatus: approval.status,
      toStatus: status,
      fromVersion: approval.version,
      toVersion: version,
      actor: command.actor,
      reasonCode: command.reasonCode,
      refs: [approval.subject],
      evidenceRefs: command.evidenceRefs,
      occurredAt: now,
    });
    return this.requireApproval(approval.approvalId);
  }

  private applyApprovalDecision(command: RecordApprovalDecisionCommand): { approval: Approval; task: Task; run?: Run } {
    const approval = this.requireApproval(command.approvalId);
    const task = this.requireTask(approval.taskId);
    this.assertVersion("Approval", approval.version, command.expectedApprovalVersion);
    this.assertVersion("Task", task.version, command.expectedTaskVersion);
    this.requireHuman(command.actor);
    requireText("decisionId", command.decisionId);
    requireText("authorityRole", command.authorityRole);
    requireText("decision reason", command.reason);
    if (approval.status !== "pending") {
      fail("approval_invalid", `Approval is not pending: ${approval.approvalId}`);
    }
    if (approval.expiresAt !== undefined && approval.expiresAt <= this.clock.now()) {
      fail("approval_invalid", `Approval has expired and must be explicitly expired: ${approval.approvalId}`);
    }
    if (!approval.requiredRoles.includes(command.authorityRole) || !command.actor.roles.includes(command.authorityRole)) {
      fail("permission_denied", `Actor does not hold required approval role: ${command.authorityRole}`);
    }
    if (command.actor.actorId === approval.requestedBy) {
      fail("permission_denied", "Approval requester cannot approve the same object");
    }
    if (approval.gate === "run_authorization" && command.decision === "approved_with_conditions") {
      fail("invalid_input", "Run Authorization cannot be approved with conditions");
    }
    this.validateDecisionConditions(command.decision, command.conditions);
    try {
      this.database
        .prepare(`
          INSERT INTO approval_decisions (
            decision_id, approval_id, approval_version, decision, authority_id, authority_role,
            reason, conditions_json, evidence_refs_json, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          command.decisionId,
          approval.approvalId,
          approval.version,
          command.decision,
          command.actor.actorId,
          command.authorityRole,
          command.reason,
          canonicalizeJson(command.conditions),
          canonicalizeJson(uniqueSorted(command.evidenceRefs, "evidence ref")),
          this.clock.now(),
        );
    } catch (error) {
      this.translateConstraint(error, `Authority already decided this Approval: ${command.actor.actorId}`);
    }
    const decisions = this.database
      .prepare("SELECT decision, authority_role, conditions_json FROM approval_decisions WHERE approval_id = ? ORDER BY decision_id")
      .all(approval.approvalId) as DecisionRow[];
    const aggregate = this.aggregateApproval(approval.requiredRoles, decisions);
    const updatedApproval = this.writeApprovalTransition(approval, aggregate, {
      commandId: command.commandId,
      actor: command.actor,
      reasonCode: aggregate === "pending" ? "approval_decision_recorded" : `approval_${aggregate}`,
      evidenceRefs: command.evidenceRefs,
    });
    if (aggregate === "pending") {
      return { approval: updatedApproval, task };
    }

    if (approval.gate === "trd_approval") {
      if (task.status !== "awaiting_trd_approval") {
        fail("invalid_transition", `Task is not awaiting TRD approval: ${task.taskId}`);
      }
      if (aggregate === "approved" || aggregate === "approved_with_conditions") {
        const updatedTask = this.writeTaskTransition(task, {
          status: "planning",
          actor: command.actor,
          commandId: command.commandId,
          reasonCode: `trd_${aggregate}`,
          refs: [approval.subject, this.approvalRef(updatedApproval)],
          evidenceRefs: command.evidenceRefs,
        });
        return { approval: updatedApproval, task: updatedTask };
      }
      if (aggregate === "changes_requested") {
        if (command.returnToStatus === undefined) {
          fail("invalid_input", "TRD changes_requested requires an explicit upstream state");
        }
        const updatedTask = this.writeTaskTransition(task, {
          status: command.returnToStatus,
          actor: command.actor,
          commandId: command.commandId,
          reasonCode: "trd_changes_requested",
          refs: [approval.subject, this.approvalRef(updatedApproval)],
          evidenceRefs: command.evidenceRefs,
        });
        return { approval: updatedApproval, task: updatedTask };
      }
      const updatedTask = this.writeTaskTransition(task, {
        status: "blocked",
        blockedReason: "trd_rejected",
        resumeToStatus: "drafting_trd",
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "trd_rejected",
        refs: [approval.subject, this.approvalRef(updatedApproval)],
        evidenceRefs: command.evidenceRefs,
      });
      return { approval: updatedApproval, task: updatedTask };
    }

    if (task.status !== "planning") {
      fail("invalid_transition", `Task is not planning an authorized Run: ${task.taskId}`);
    }
    const run = this.requireRunByAuthorization(approval.approvalId);
    if (command.expectedRunVersion === undefined) {
      fail("invalid_input", "Run Authorization decision requires expectedRunVersion");
    }
    this.assertRun(run, command.expectedRunVersion, "awaiting_authorization");
    if (aggregate === "approved") {
      this.assertRunPrerequisitesEffective(run, this.getRunManifest(run.runId).manifest);
      const updatedRun = this.writeRunTransition(run, {
        status: "authorized",
        reasonCode: "run_authorized",
        actor: command.actor,
        commandId: command.commandId,
        refs: [this.approvalRef(updatedApproval)],
        evidenceRefs: command.evidenceRefs,
      });
      const updatedTask = this.writeTaskTransition(task, {
        status: "executing",
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "run_authorized",
        refs: [{ id: run.runId, version: "1", digest: run.manifestDigest }, this.approvalRef(updatedApproval)],
        evidenceRefs: command.evidenceRefs,
      });
      return { approval: updatedApproval, task: updatedTask, run: updatedRun };
    }
    const updatedRun = this.writeRunTransition(run, {
      status: "settled",
      outcome: "rejected",
      settledAt: this.clock.now(),
      reasonCode: aggregate === "changes_requested" ? "run_changes_requested" : "run_rejected",
      actor: command.actor,
      commandId: command.commandId,
      refs: [this.approvalRef(updatedApproval)],
      evidenceRefs: command.evidenceRefs,
    });
    if (aggregate === "changes_requested") {
      return { approval: updatedApproval, task, run: updatedRun };
    }
    const updatedTask = this.writeTaskTransition(task, {
      status: "blocked",
      blockedReason: "run_authorization_rejected",
      resumeToStatus: "planning",
      actor: command.actor,
      commandId: command.commandId,
      reasonCode: "run_authorization_rejected",
      refs: [this.approvalRef(updatedApproval)],
      evidenceRefs: command.evidenceRefs,
    });
    return { approval: updatedApproval, task: updatedTask, run: updatedRun };
  }

  private validateDecisionConditions(decision: ApprovalDecisionValue, conditions: readonly ApprovalCondition[]): void {
    if (decision === "approved_with_conditions" && conditions.length === 0) {
      fail("invalid_input", "approved_with_conditions requires at least one structured condition");
    }
    if (decision !== "approved_with_conditions" && conditions.length > 0) {
      fail("invalid_input", `Decision ${decision} cannot carry approval conditions`);
    }
    const ids = new Set<string>();
    for (const condition of conditions) {
      requireText("conditionId", condition.conditionId);
      requireText("condition description", condition.description);
      requireText("condition owner", condition.owner);
      requireText("condition verificationMethod", condition.verificationMethod);
      if (ids.has(condition.conditionId)) {
        fail("invalid_input", `Duplicate approval condition: ${condition.conditionId}`);
      }
      ids.add(condition.conditionId);
      if (condition.requiredBefore === "planning" && condition.evidenceRefs.length === 0) {
        fail("invalid_input", `Planning condition lacks completion evidence: ${condition.conditionId}`);
      }
    }
  }

  private aggregateApproval(requiredRoles: readonly string[], decisions: readonly DecisionRow[]): ApprovalStatus {
    if (decisions.some((row) => row.decision === "rejected")) {
      return "rejected";
    }
    if (decisions.some((row) => row.decision === "changes_requested")) {
      return "changes_requested";
    }
    const satisfied = new Set(
      decisions
        .filter((row) => row.decision === "approved" || row.decision === "approved_with_conditions")
        .map((row) => row.authority_role),
    );
    if (!requiredRoles.every((role) => satisfied.has(role))) {
      return "pending";
    }
    return decisions.some((row) => row.decision === "approved_with_conditions")
      ? "approved_with_conditions"
      : "approved";
  }

  private validateManifest(task: Task, runId: string, manifest: RunManifestV1): void {
    requireText("runId", runId);
    if (manifest.schemaVersion !== "1" || manifest.runId !== runId) {
      fail("invalid_input", "RunManifest schemaVersion or runId is invalid");
    }
    if (manifest.task.taskId !== task.taskId || manifest.task.taskRevision !== task.version) {
      fail("version_conflict", "RunManifest does not bind the current Task revision");
    }
    if (task.contextManifest === undefined || task.trd === undefined) {
      fail("invalid_transition", "Task lacks sealed ContextManifest or TRD");
    }
    for (const [label, expected, actual] of [
      ["PRD", task.prd, manifest.inputs.prd],
      ["ContextManifest", task.contextManifest, manifest.inputs.contextManifest],
      ["TRD", task.trd, manifest.inputs.trd],
    ] as const) {
      if (!this.sameRef(expected, actual)) {
        fail("digest_mismatch", `RunManifest ${label} does not match the Task`);
      }
    }
    this.requireArtifact(manifest.inputs.prd, "prd");
    this.requireArtifact(manifest.inputs.contextManifest, "context_manifest");
    this.requireArtifact(manifest.inputs.trd, "trd");
    this.requireArtifact(manifest.inputs.executionPlan, "execution_plan");
    this.requireArtifact(manifest.verification.acceptanceCriteria, "acceptance_criteria");
    for (const check of manifest.verification.requiredChecks) {
      this.requireArtifact(check, "check_definition");
    }
    let hasTrdApproval = false;
    for (const ref of manifest.inputs.prerequisiteApprovals) {
      const approval = this.requireApproval(ref.id);
      if (!this.sameRef(this.approvalRef(approval), ref)) {
        fail("digest_mismatch", `Approval snapshot does not match RunManifest: ${ref.id}`);
      }
      if (!["approved", "approved_with_conditions"].includes(approval.status)) {
        fail("approval_invalid", `Prerequisite Approval is not effective: ${ref.id}`);
      }
      if (approval.gate === "trd_approval" && this.sameRef(approval.subject, task.trd)) {
        hasTrdApproval = true;
      }
    }
    if (!hasTrdApproval) {
      fail("approval_invalid", "RunManifest lacks the effective TRD Approval snapshot");
    }
    requireText("repositoryId", manifest.target.repositoryId);
    if (!/^[0-9a-f]{40,64}$/.test(manifest.target.baseCommit)) {
      fail("invalid_input", "RunManifest target.baseCommit must be a fixed lowercase Git object ID");
    }
    const paths = uniqueSorted(manifest.target.allowedPaths, "allowed path");
    if (
      paths.length === 0 ||
      paths.some((path) => path.startsWith("/") || path.split("/").some((segment) => segment === ".." || segment === ""))
    ) {
      fail("invalid_input", "RunManifest allowedPaths must be non-empty normalized relative paths");
    }
    requireText("runtime harnessCommit", manifest.runtime.harnessCommit);
    requirePositiveInteger("maxRoleRuns", manifest.policies.maxRoleRuns);
    requirePositiveInteger("maxDurationMs", manifest.policies.maxDurationMs);
    const roleIds = uniqueSorted(manifest.roles.map((role) => role.rolePlanId), "rolePlanId");
    if (roleIds.length !== manifest.roles.length) {
      fail("invalid_input", "RunManifest has duplicate RolePlan IDs");
    }
    if (!manifest.roles.some((role) => role.role === "executor") || !manifest.roles.some((role) => role.role === "verifier")) {
      fail("invalid_input", "RunManifest requires separate Executor and Verifier RolePlans");
    }
    if (manifest.policies.maxRoleRuns < 2) {
      fail("invalid_input", "RunManifest maxRoleRuns cannot complete Executor and Verifier separation");
    }
    for (const role of manifest.roles) {
      requireText("model provider", role.model.provider);
      requireText("modelId", role.model.modelId);
      requirePositiveInteger("role maxAttempts", role.limits.maxAttempts);
      requirePositiveInteger("role timeoutMs", role.limits.timeoutMs);
      uniqueSorted(role.tools.map((tool) => tool.name), "tool name");
      uniqueSorted(role.credentialBindings.map((binding) => binding.bindingId), "credential binding ID");
      for (const binding of role.credentialBindings) {
        requireText("credential provider", binding.provider);
        uniqueSorted(binding.scopes, "credential scope");
      }
    }
  }

  private assertRunPrerequisitesEffective(run: Run, manifest: RunManifestV1): void {
    for (const ref of manifest.inputs.prerequisiteApprovals) {
      const approval = this.requireApproval(ref.id);
      if (!this.sameRef(this.approvalRef(approval), ref) || !["approved", "approved_with_conditions"].includes(approval.status)) {
        fail("approval_invalid", `Run prerequisite Approval is no longer effective: ${ref.id}`);
      }
    }
    if (manifest.runId !== run.runId || sha256Digest(canonicalizeJson(manifest)) !== run.manifestDigest) {
      fail("digest_mismatch", `RunManifest no longer matches Run: ${run.runId}`);
    }
  }

  private assertRunApprovalsEffective(run: Run, manifest: RunManifestV1): void {
    this.assertRunPrerequisitesEffective(run, manifest);
    const authorization = this.requireApproval(run.authorizationApprovalId);
    if (authorization.status !== "approved" || authorization.subject.digest !== run.manifestDigest) {
      fail("approval_invalid", `Run Authorization is no longer effective: ${authorization.approvalId}`);
    }
  }

  private validateVerificationRouting(verdict: string, findingClass: string | undefined): void {
    if (verdict === "pass" && findingClass !== undefined) {
      fail("invalid_input", "PASS cannot carry a findingClass");
    }
    if (verdict === "fail" && (findingClass === undefined || findingClass === "external")) {
      fail("invalid_input", "FAIL requires implementation, trd, context, or prd findingClass");
    }
    if (verdict === "blocked" && findingClass !== "external") {
      fail("invalid_input", "BLOCKED is reserved for a confirmed external gap");
    }
  }

  private upstreamForFinding(findingClass: string): "intake" | "contextualizing" | "drafting_trd" {
    if (findingClass === "prd") {
      return "intake";
    }
    if (findingClass === "context") {
      return "contextualizing";
    }
    if (findingClass === "trd") {
      return "drafting_trd";
    }
    fail("invalid_input", `Finding does not have an upstream design state: ${findingClass}`);
  }

  private requirePassingVerification(ref: VersionedRef, task: Task, run: Run, executionResult: VersionedRef): Artifact {
    const artifact = this.requireArtifact(ref, "verification_result");
    this.assertVerificationResultBinding(artifact, task, run, executionResult, "pass");
    return artifact;
  }

  private assertExecutionResultBinding(artifact: Artifact, task: Task, run: Run): void {
    const content = this.requireObjectContent(artifact);
    if (
      content.taskId !== task.taskId ||
      content.runId !== run.runId ||
      content.manifestDigest !== run.manifestDigest
    ) {
      fail("digest_mismatch", `ExecutionResult does not bind the current Task, Run, and Manifest: ${artifact.id}`);
    }
  }

  private assertVerificationResultBinding(
    artifact: Artifact,
    task: Task,
    run: Run,
    executionResult: VersionedRef,
    verdict: string,
    findingClass?: string,
  ): void {
    const content = this.requireObjectContent(artifact);
    if (content.taskId !== task.taskId || content.runId !== run.runId || content.verdict !== verdict) {
      fail("digest_mismatch", `VerificationResult does not bind the current Task, Run, and verdict: ${artifact.id}`);
    }
    const execution = content.executionResult;
    if (
      execution === null ||
      Array.isArray(execution) ||
      typeof execution !== "object" ||
      execution.id !== executionResult.id ||
      execution.version !== executionResult.version ||
      execution.digest !== executionResult.digest
    ) {
      fail("digest_mismatch", `VerificationResult does not bind the exact ExecutionResult: ${artifact.id}`);
    }
    if (findingClass !== undefined && content.findingClass !== findingClass) {
      fail("digest_mismatch", `VerificationResult findingClass does not match the submitted route: ${artifact.id}`);
    }
  }

  private requireObjectContent(artifact: Artifact): { [key: string]: JsonValue } {
    if (artifact.content === null || Array.isArray(artifact.content) || typeof artifact.content !== "object") {
      fail("invalid_input", `Artifact content must be an object: ${artifact.id}@${artifact.version}`);
    }
    return artifact.content;
  }

  private applyCancellation(command: CancelTaskCommand): { task: Task; run?: Run } {
    const task = this.requireTask(command.taskId);
    this.assertVersion("Task", task.version, command.expectedTaskVersion);
    this.requireHuman(command.actor);
    requireText("reasonCode", command.reasonCode);
    if (task.status === "closed") {
      fail("invalid_transition", `Task is already closed: ${task.taskId}`);
    }
    const run = this.unsettledRunForTask(task.taskId);
    if (run === undefined) {
      const updatedTask = this.writeTaskTransition(task, {
        status: "closed",
        outcome: "cancelled",
        closedAt: this.clock.now(),
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: command.reasonCode,
        refs: [],
        evidenceRefs: command.evidenceRefs,
      });
      return { task: updatedTask };
    }
    if (command.expectedRunVersion === undefined) {
      fail("invalid_input", "Cancelling a Task with an unsettled Run requires expectedRunVersion");
    }
    this.assertVersion("Run", run.version, command.expectedRunVersion);
    const roleRun = this.unsettledRoleRun(run.runId);
    if (run.status === "awaiting_authorization") {
      const approval = this.requireApproval(run.authorizationApprovalId);
      if (approval.status === "pending") {
        this.writeApprovalTransition(approval, "withdrawn", {
          commandId: command.commandId,
          actor: command.actor,
          reasonCode: "task_cancelled",
          evidenceRefs: command.evidenceRefs,
        });
      }
    }
    if (roleRun === undefined) {
      const now = this.clock.now();
      const updatedRun = this.writeRunTransition(run, {
        status: "settled",
        outcome: "cancelled",
        settledAt: now,
        reasonCode: command.reasonCode,
        actor: command.actor,
        commandId: command.commandId,
        refs: [],
        evidenceRefs: command.evidenceRefs,
      });
      const updatedTask = this.writeTaskTransition(task, {
        status: "closed",
        outcome: "cancelled",
        closedAt: now,
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: command.reasonCode,
        refs: [],
        evidenceRefs: command.evidenceRefs,
      });
      return { task: updatedTask, run: updatedRun };
    }
    if (!["authorized", "active", "blocked"].includes(run.status)) {
      fail("invalid_transition", `Run cannot enter cancellation from ${run.status}`);
    }
    const resumeToStatus = task.status === "blocked" ? (task.resumeToStatus ?? "executing") : task.status;
    if (["closed", "blocked"].includes(resumeToStatus)) {
      fail("invalid_transition", `Task cannot record cancellation recovery target: ${resumeToStatus}`);
    }
    const updatedTask = this.writeTaskTransition(task, {
      status: "blocked",
      blockedReason: command.reasonCode,
      resumeToStatus,
      actor: command.actor,
      commandId: command.commandId,
      reasonCode: command.reasonCode,
      refs: [],
      evidenceRefs: command.evidenceRefs,
    });
    const updatedRun = this.writeRunTransition(run, {
      status: "stopping",
      pendingOutcome: "cancelled",
      reasonCode: command.reasonCode,
      actor: command.actor,
      commandId: command.commandId,
      refs: [],
      evidenceRefs: command.evidenceRefs,
    });
    return { task: updatedTask, run: updatedRun };
  }

  private applyFinishRunStop(command: FinishRunStopCommand): { task: Task; run: Run } {
    const task = this.requireTask(command.taskId);
    const run = this.requireRun(command.runId);
    this.assertTask(task, command.expectedTaskVersion, "blocked");
    this.assertVersion("Run", run.version, command.expectedRunVersion);
    if (run.taskId !== task.taskId || !["stopping", "blocked"].includes(run.status)) {
      fail("invalid_transition", "Task and Run are not waiting for stop settlement");
    }
    if (run.status === "stopping" && run.pendingOutcome !== command.outcome) {
      fail("invalid_input", "Run stop outcome does not match pendingOutcome");
    }
    if (run.status === "blocked" && run.resumeToStatus !== "stopping") {
      fail("invalid_transition", "Blocked Run is not waiting to resume stop settlement");
    }
    if (this.unsettledRoleRun(run.runId) !== undefined) {
      fail("invalid_transition", "Run cannot settle while a RoleRun is unsettled");
    }
    const now = this.clock.now();
    const updatedRun = this.writeRunTransition(run, {
      status: "settled",
      outcome: command.outcome,
      settledAt: now,
      reasonCode: `run_${command.outcome}`,
      actor: command.actor,
      commandId: command.commandId,
      refs: [],
      evidenceRefs: command.evidenceRefs,
    });
    if (command.outcome === "cancelled") {
      const updatedTask = this.writeTaskTransition(task, {
        status: "closed",
        outcome: "cancelled",
        closedAt: now,
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "task_cancelled",
        refs: [],
        evidenceRefs: command.evidenceRefs,
      });
      return { task: updatedTask, run: updatedRun };
    }
    if (command.outcome === "superseded") {
      if (command.upstreamStatus === undefined) {
        fail("invalid_input", "Superseded Run requires an upstreamStatus");
      }
      const updatedTask = this.writeTaskTransition(task, {
        status: command.upstreamStatus,
        actor: command.actor,
        commandId: command.commandId,
        reasonCode: "run_superseded",
        refs: [],
        evidenceRefs: command.evidenceRefs,
      });
      return { task: updatedTask, run: updatedRun };
    }
    return { task, run: updatedRun };
  }

  private applyApprovalInvalidation(command: InvalidateApprovalCommand): { approval: Approval; task: Task; run?: Run } {
    const approval = this.requireApproval(command.approvalId);
    const task = this.requireTask(approval.taskId);
    this.assertVersion("Approval", approval.version, command.expectedApprovalVersion);
    this.assertVersion("Task", task.version, command.expectedTaskVersion);
    requireText("reasonCode", command.reasonCode);
    if (command.action === "expired") {
      if (command.actor.actorType !== "system" || approval.status !== "pending" || approval.expiresAt === undefined || approval.expiresAt > this.clock.now()) {
        fail("permission_denied", "Approval expiry requires the system actor and an elapsed deadline");
      }
    } else if (command.action === "withdrawn") {
      this.requireHuman(command.actor);
      if (approval.status !== "pending" || (command.actor.actorId !== approval.requestedBy && !command.actor.roles.includes("approval_admin"))) {
        fail("permission_denied", "Only the requester or approval_admin can withdraw a pending Approval");
      }
    } else {
      this.requireHuman(command.actor);
      if (!["approved", "approved_with_conditions"].includes(approval.status) || !command.actor.roles.includes("approval_revoker")) {
        fail("permission_denied", "Revocation requires an effective Approval and approval_revoker role");
      }
    }
    const updatedApproval = this.writeApprovalTransition(approval, command.action, {
      commandId: command.commandId,
      actor: command.actor,
      reasonCode: command.reasonCode,
      evidenceRefs: command.evidenceRefs,
    });
    if (task.status === "closed") {
      this.insertOutbox(
        "security.approval_invalidated",
        "approval",
        approval.approvalId,
        { approvalId: approval.approvalId, taskId: task.taskId, action: command.action },
        this.clock.now(),
      );
      return { approval: updatedApproval, task };
    }
    const run = this.unsettledRunForTask(task.taskId);
    if (run !== undefined) {
      if (command.expectedRunVersion === undefined) {
        fail("invalid_input", "Invalidating an Approval with an unsettled Run requires expectedRunVersion");
      }
      this.assertVersion("Run", run.version, command.expectedRunVersion);
      if (run.status === "awaiting_authorization") {
        const updatedRun = this.writeRunTransition(run, {
          status: "settled",
          outcome: "rejected",
          settledAt: this.clock.now(),
          reasonCode: command.reasonCode,
          actor: command.actor,
          commandId: command.commandId,
          refs: [this.approvalRef(updatedApproval)],
          evidenceRefs: command.evidenceRefs,
        });
        return { approval: updatedApproval, task, run: updatedRun };
      }
      if (!["stopping", "settled"].includes(run.status)) {
        const resumeToStatus = approval.gate === "trd_approval" ? "drafting_trd" : "planning";
        const updatedTask =
          task.status === "blocked"
            ? task
            : this.writeTaskTransition(task, {
                status: "blocked",
                blockedReason: command.reasonCode,
                resumeToStatus,
                actor: command.actor,
                commandId: command.commandId,
                reasonCode: command.reasonCode,
                refs: [this.approvalRef(updatedApproval)],
                evidenceRefs: command.evidenceRefs,
              });
        const updatedRun = this.writeRunTransition(run, {
          status: "stopping",
          pendingOutcome: "superseded",
          reasonCode: command.reasonCode,
          actor: command.actor,
          commandId: command.commandId,
          refs: [this.approvalRef(updatedApproval)],
          evidenceRefs: command.evidenceRefs,
        });
        return { approval: updatedApproval, task: updatedTask, run: updatedRun };
      }
    }
    const resumeToStatus = approval.gate === "trd_approval" ? "drafting_trd" : "planning";
    const updatedTask = this.writeTaskTransition(task, {
      status: task.status === "awaiting_trd_approval" ? "drafting_trd" : "blocked",
      ...(task.status === "awaiting_trd_approval"
        ? {}
        : { blockedReason: command.reasonCode, resumeToStatus }),
      actor: command.actor,
      commandId: command.commandId,
      reasonCode: command.reasonCode,
      refs: [this.approvalRef(updatedApproval)],
      evidenceRefs: command.evidenceRefs,
    });
    return { approval: updatedApproval, task: updatedTask };
  }

  private insertOutbox(
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: JsonValue,
    now: string,
  ): void {
    this.database
      .prepare(`
        INSERT INTO outbox (
          event_id, event_type, aggregate_type, aggregate_id, payload_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `)
      .run(this.ids.next("event"), eventType, aggregateType, aggregateId, canonicalizeJson(payload), now);
  }

  private approvalRef(approval: Approval): VersionedRef {
    return { id: approval.approvalId, version: String(approval.version), digest: digestJson(approval) };
  }

  private requireRunByAuthorization(approvalId: string): Run {
    const row = this.database
      .prepare("SELECT * FROM runs WHERE authorization_approval_id = ?")
      .get(approvalId) as SqlRow | undefined;
    if (row === undefined) {
      fail("not_found", `Run not found for Authorization Approval: ${approvalId}`);
    }
    return runFromRow(row);
  }

  private unsettledRunForTask(taskId: string): Run | undefined {
    const row = this.database
      .prepare("SELECT * FROM runs WHERE task_id = ? AND status <> 'settled'")
      .get(taskId) as SqlRow | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  private unsettledRoleRun(runId: string): RoleRun | undefined {
    const row = this.database
      .prepare("SELECT * FROM role_runs WHERE run_id = ? AND status <> 'settled'")
      .get(runId) as SqlRow | undefined;
    return row === undefined ? undefined : roleRunFromRow(row);
  }

  private sameRef(left: VersionedRef, right: VersionedRef): boolean {
    return left.id === right.id && left.version === right.version && left.digest === right.digest;
  }

  private cleanRef(ref: VersionedRef): VersionedRef {
    return { id: ref.id, version: ref.version, digest: ref.digest };
  }

  private readTransitions(table: string, ownerColumn: string, ownerId: string, hasLease = false): StoredTransition[] {
    const rows = this.database
      .prepare(`SELECT *, ${ownerColumn} AS owner_id FROM ${table} WHERE ${ownerColumn} = ? ORDER BY occurred_at, transition_id`)
      .all(ownerId) as SqlRow[];
    return rows.map((row) => ({
      transitionId: asText(row, "transition_id"),
      ownerId: asText(row, "owner_id"),
      commandId: asText(row, "command_id"),
      ...(optionalText(row, "from_status") === undefined ? {} : { fromStatus: optionalText(row, "from_status")! }),
      toStatus: asText(row, "to_status"),
      ...(optionalNumber(row, "from_version") === undefined ? {} : { fromVersion: optionalNumber(row, "from_version")! }),
      toVersion: asNumber(row, "to_version"),
      actor: {
        actorId: asText(row, "actor_id"),
        actorType: asText(row, "actor_type") as Actor["actorType"],
        roles: parseJson<string[]>(asText(row, "actor_roles_json")),
      },
      reasonCode: asText(row, "reason_code"),
      refs: parseJson<VersionedRef[]>(asText(row, "refs_json")),
      evidenceRefs: parseJson<string[]>(asText(row, "evidence_refs_json")),
      ...(hasLease ? { leaseToken: asNumber(row, "lease_token") } : {}),
      occurredAt: asText(row, "occurred_at"),
    }));
  }

  private translateConstraint(error: unknown, message: string): never {
    if (error instanceof ControlPlaneError) {
      throw error;
    }
    if (error instanceof Error && /constraint|unique/i.test(error.message)) {
      fail("already_exists", message);
    }
    throw error;
  }
}
