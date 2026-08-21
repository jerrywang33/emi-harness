import type { DatabaseSync } from "node:sqlite";

import { sha256Text } from "./canonical-json.js";

interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_tool_gateway_v1",
    sql: `
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('authorized', 'denied', 'executing', 'failed', 'succeeded', 'unknown')),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  role_run_id TEXT NOT NULL,
  lease_token INTEGER NOT NULL CHECK (lease_token > 0),
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  policy_ref_json TEXT NOT NULL,
  error_code TEXT,
  sanitized_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK ((status IN ('denied', 'failed', 'succeeded')) = (terminal_at IS NOT NULL)),
  CHECK ((error_code IS NULL AND sanitized_error IS NULL) OR (error_code IS NOT NULL AND sanitized_error IS NOT NULL))
) STRICT;

CREATE TABLE policy_decisions (
  decision_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('allow', 'deny')),
  reason_codes_json TEXT NOT NULL,
  authority_digest TEXT NOT NULL,
  policy_ref_json TEXT NOT NULL,
  decided_at TEXT NOT NULL
) STRICT;

CREATE TABLE operation_intents (
  intent_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id),
  schema_version TEXT NOT NULL CHECK (schema_version = '1'),
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  allowed_path TEXT NOT NULL,
  isolation_profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE operation_results (
  result_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('failed', 'succeeded')),
  source TEXT NOT NULL CHECK (source IN ('execution', 'reconciliation')),
  output_json TEXT NOT NULL,
  output_digest TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  error_code TEXT,
  sanitized_error TEXT,
  created_at TEXT NOT NULL,
  CHECK ((outcome = 'failed') = (error_code IS NOT NULL AND sanitized_error IS NOT NULL))
) STRICT;

CREATE TABLE operation_transitions (
  transition_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  from_status TEXT,
  to_status TEXT NOT NULL CHECK (to_status IN ('authorized', 'denied', 'executing', 'failed', 'succeeded', 'unknown')),
  from_version INTEGER,
  to_version INTEGER NOT NULL CHECK (to_version > 0),
  reason_code TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (operation_id, to_version)
) STRICT;

CREATE TRIGGER policy_decisions_immutable_update BEFORE UPDATE ON policy_decisions BEGIN
  SELECT RAISE(ABORT, 'policy decisions are immutable');
END;
CREATE TRIGGER policy_decisions_immutable_delete BEFORE DELETE ON policy_decisions BEGIN
  SELECT RAISE(ABORT, 'policy decisions are immutable');
END;
CREATE TRIGGER operation_intents_immutable_update BEFORE UPDATE ON operation_intents BEGIN
  SELECT RAISE(ABORT, 'operation intents are immutable');
END;
CREATE TRIGGER operation_intents_immutable_delete BEFORE DELETE ON operation_intents BEGIN
  SELECT RAISE(ABORT, 'operation intents are immutable');
END;
CREATE TRIGGER operation_results_immutable_update BEFORE UPDATE ON operation_results BEGIN
  SELECT RAISE(ABORT, 'operation results are immutable');
END;
CREATE TRIGGER operation_results_immutable_delete BEFORE DELETE ON operation_results BEGIN
  SELECT RAISE(ABORT, 'operation results are immutable');
END;
CREATE TRIGGER operation_transitions_immutable_update BEFORE UPDATE ON operation_transitions BEGIN
  SELECT RAISE(ABORT, 'operation transitions are immutable');
END;
CREATE TRIGGER operation_transitions_immutable_delete BEFORE DELETE ON operation_transitions BEGIN
  SELECT RAISE(ABORT, 'operation transitions are immutable');
END;
`,
  },
];

export function applyMigrations(database: DatabaseSync, now: () => string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      digest TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const findMigration = database.prepare("SELECT digest FROM schema_migrations WHERE migration_id = ?");
  const recordMigration = database.prepare(
    "INSERT INTO schema_migrations (migration_id, digest, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of MIGRATIONS) {
    const digest = sha256Text(migration.sql);
    const existing = findMigration.get(migration.id) as { digest: string } | undefined;
    if (existing !== undefined) {
      if (existing.digest !== digest) {
        throw new Error(`Applied migration digest mismatch: ${migration.id}`);
      }
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      recordMigration.run(migration.id, digest, now());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
