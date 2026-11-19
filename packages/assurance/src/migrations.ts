import type { LedgerMigration } from "@emi-harness/sqlite-ledger";

export const EVIDENCE_STORE_MIGRATIONS: readonly LedgerMigration[] = [
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
