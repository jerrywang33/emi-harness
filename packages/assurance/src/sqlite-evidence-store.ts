import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { canonicalizeJson, digestJson, isSha256, sha256Text } from "./canonical-json.js";
import { fail } from "./errors.js";
import { applyMigrations } from "./migrations.js";
import type { Clock, EvidenceRecord, EvidenceRecordInput, VersionedRef } from "./types.js";

interface SqlRow {
  [key: string]: null | number | bigint | string | Uint8Array;
}

export interface SqliteEvidenceStoreConfig {
  databasePath: string;
  clock?: Clock;
}

const systemClock: Clock = { now: () => new Date().toISOString() };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;

function asText(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Expected text column: ${key}`);
  return value;
}

function optionalText(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : asText(row, key);
}

function normalizeRefs(refs: readonly VersionedRef[]): VersionedRef[] {
  const result = refs.map((ref) => {
    if (!ID.test(ref.id) || !ID.test(ref.version) || !isSha256(ref.digest)) {
      fail("invalid_input", `Invalid Evidence subject ref: ${ref.id}@${ref.version}`);
    }
    return { id: ref.id, version: ref.version, digest: ref.digest };
  }).sort((left, right) => {
    const leftKey = `${left.id}\u0000${left.version}\u0000${left.digest}`;
    const rightKey = `${right.id}\u0000${right.version}\u0000${right.digest}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (new Set(result.map((ref) => `${ref.id}\u0000${ref.version}\u0000${ref.digest}`)).size !== result.length) {
    fail("invalid_input", "Evidence subject refs must not contain duplicates");
  }
  return result;
}

function normalizeInput(input: EvidenceRecordInput): EvidenceRecordInput {
  for (const [label, value] of [
    ["evidenceId", input.evidenceId],
    ["version", input.version],
    ["taskId", input.taskId],
    ["runId", input.runId],
    ["producerId", input.producer.producerId],
  ] as const) {
    if (!ID.test(value)) fail("invalid_input", `${label} is invalid`);
  }
  if (input.roleRunId !== undefined && !ID.test(input.roleRunId)) fail("invalid_input", "roleRunId is invalid");
  if (!["check_result", "execution", "runtime", "tool_operation", "verification_assurance"].includes(input.kind)) {
    fail("invalid_input", `Evidence kind is invalid: ${input.kind}`);
  }
  if (!["agent", "system", "worker"].includes(input.producer.producerType)) {
    fail("invalid_input", `Evidence producer type is invalid: ${input.producer.producerType}`);
  }
  return {
    evidenceId: input.evidenceId,
    version: input.version,
    kind: input.kind,
    taskId: input.taskId,
    runId: input.runId,
    ...(input.roleRunId === undefined ? {} : { roleRunId: input.roleRunId }),
    producer: { ...input.producer },
    subjectRefs: normalizeRefs(input.subjectRefs),
    content: input.content,
  };
}

function recordFromRow(row: SqlRow): EvidenceRecord {
  const canonicalJson = asText(row, "canonical_json");
  const digest = asText(row, "digest");
  if (sha256Text(canonicalJson) !== digest) {
    fail("evidence_corrupt", `Stored Evidence digest is corrupt: ${asText(row, "evidence_id")}`);
  }
  const envelope = JSON.parse(canonicalJson) as Omit<EvidenceRecord, "canonicalJson" | "digest">;
  const { createdAt: _createdAt, ...storedInput } = envelope;
  if (
    envelope.evidenceId !== asText(row, "evidence_id") ||
    envelope.version !== asText(row, "evidence_version") ||
    envelope.kind !== asText(row, "kind") ||
    envelope.taskId !== asText(row, "task_id") ||
    envelope.runId !== asText(row, "run_id") ||
    envelope.roleRunId !== optionalText(row, "role_run_id") ||
    envelope.producer.producerId !== asText(row, "producer_id") ||
    envelope.producer.producerType !== asText(row, "producer_type") ||
    envelope.createdAt !== asText(row, "created_at") ||
    digestJson(storedInput) !== asText(row, "input_digest")
  ) {
    fail("evidence_corrupt", `Stored Evidence columns do not match content: ${envelope.evidenceId}`);
  }
  return { ...envelope, digest, canonicalJson };
}

export function formatEvidenceRef(record: Pick<EvidenceRecord, "digest" | "evidenceId" | "version">): string {
  return `evidence:${record.evidenceId}@${record.version}#${record.digest}`;
}

export class SqliteEvidenceStore {
  private readonly database: DatabaseSync;
  private readonly clock: Clock;

  constructor(config: SqliteEvidenceStoreConfig) {
    if (config.databasePath.trim().length === 0) fail("invalid_input", "databasePath must not be empty");
    this.clock = config.clock ?? systemClock;
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
    if (config.databasePath !== ":memory:" && !existed) chmodSync(config.databasePath, 0o600);
  }

  close(): void {
    this.database.close();
  }

  put(input: EvidenceRecordInput): EvidenceRecord {
    const normalized = normalizeInput(input);
    const inputDigest = digestJson(normalized);
    const existing = this.find(normalized.evidenceId, normalized.version);
    if (existing !== undefined) {
      const storedInput = this.database
        .prepare("SELECT input_digest FROM evidence_records WHERE evidence_id = ? AND evidence_version = ?")
        .get(normalized.evidenceId, normalized.version) as SqlRow;
      if (asText(storedInput, "input_digest") !== inputDigest) {
        fail("evidence_conflict", `Evidence ID was reused with different content: ${normalized.evidenceId}@${normalized.version}`);
      }
      return existing;
    }
    const createdAt = this.clock.now();
    const envelope = { ...normalized, createdAt };
    const canonicalJson = canonicalizeJson(envelope);
    const storedRecord: EvidenceRecord = { ...envelope, digest: sha256Text(canonicalJson), canonicalJson };
    try {
      this.database
        .prepare(`
          INSERT INTO evidence_records (
            evidence_id, evidence_version, kind, task_id, run_id, role_run_id,
            producer_id, producer_type, input_digest, digest, canonical_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          storedRecord.evidenceId,
          storedRecord.version,
          storedRecord.kind,
          storedRecord.taskId,
          storedRecord.runId,
          storedRecord.roleRunId ?? null,
          storedRecord.producer.producerId,
          storedRecord.producer.producerType,
          inputDigest,
          storedRecord.digest,
          storedRecord.canonicalJson,
          storedRecord.createdAt,
        );
    } catch (error) {
      const concurrent = this.find(normalized.evidenceId, normalized.version);
      if (concurrent !== undefined) {
        const storedInput = this.database
          .prepare("SELECT input_digest FROM evidence_records WHERE evidence_id = ? AND evidence_version = ?")
          .get(normalized.evidenceId, normalized.version) as SqlRow;
        if (asText(storedInput, "input_digest") !== inputDigest) {
          fail("evidence_conflict", `Evidence ID was reused with different content: ${normalized.evidenceId}@${normalized.version}`);
        }
        return concurrent;
      }
      throw error;
    }
    return this.get({ id: storedRecord.evidenceId, version: storedRecord.version, digest: storedRecord.digest });
  }

  get(ref: VersionedRef): EvidenceRecord {
    const record = this.find(ref.id, ref.version);
    if (record === undefined) fail("not_found", `Evidence not found: ${ref.id}@${ref.version}`);
    if (record.digest !== ref.digest) fail("evidence_corrupt", `Evidence ref digest mismatch: ${ref.id}@${ref.version}`);
    return record;
  }

  listForRun(runId: string): EvidenceRecord[] {
    return (this.database.prepare("SELECT * FROM evidence_records WHERE run_id = ? ORDER BY created_at, evidence_id").all(runId) as SqlRow[])
      .map(recordFromRow);
  }

  private find(evidenceId: string, version: string): EvidenceRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM evidence_records WHERE evidence_id = ? AND evidence_version = ?")
      .get(evidenceId, version) as SqlRow | undefined;
    return row === undefined ? undefined : recordFromRow(row);
  }
}
