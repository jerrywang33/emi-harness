import type { DatabaseSync } from "node:sqlite";

import { sha256Text } from "./canonical-json.js";

const MIGRATIONS = [
  {
    id: "0001_evidence_store_v1",
    sql: `
CREATE TABLE evidence_records (
  evidence_id TEXT NOT NULL,
  evidence_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('check_result', 'execution', 'runtime', 'tool_operation', 'verification_assurance')),
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  role_run_id TEXT,
  producer_id TEXT NOT NULL,
  producer_type TEXT NOT NULL CHECK (producer_type IN ('agent', 'system', 'worker')),
  input_digest TEXT NOT NULL,
  digest TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (evidence_id, evidence_version),
  UNIQUE (evidence_id, evidence_version, digest)
) STRICT;

CREATE INDEX evidence_by_run ON evidence_records(run_id, role_run_id, created_at, evidence_id);

CREATE TRIGGER evidence_records_immutable_update BEFORE UPDATE ON evidence_records BEGIN
  SELECT RAISE(ABORT, 'evidence records are immutable');
END;
CREATE TRIGGER evidence_records_immutable_delete BEFORE DELETE ON evidence_records BEGIN
  SELECT RAISE(ABORT, 'evidence records are immutable');
END;
`,
  },
] as const;

export function applyMigrations(database: DatabaseSync, now: () => string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      digest TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const find = database.prepare("SELECT digest FROM schema_migrations WHERE migration_id = ?");
  const insert = database.prepare("INSERT INTO schema_migrations (migration_id, digest, applied_at) VALUES (?, ?, ?)");
  for (const migration of MIGRATIONS) {
    const digest = sha256Text(migration.sql);
    const existing = find.get(migration.id) as { digest: string } | undefined;
    if (existing !== undefined) {
      if (existing.digest !== digest) throw new Error(`Applied migration digest mismatch: ${migration.id}`);
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      insert.run(migration.id, digest, now());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
