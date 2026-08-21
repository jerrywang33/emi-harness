import type { DatabaseSync } from "node:sqlite";

import { sha256Digest } from "./canonical-json.js";

interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_control_plane_v1",
    sql: `
CREATE TABLE artifacts (
  artifact_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (digest GLOB 'sha256:[0-9a-f]*' AND length(digest) = 71),
  canonical_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, artifact_version),
  UNIQUE (artifact_id, artifact_version, digest)
) STRICT;

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN (
    'intake', 'contextualizing', 'drafting_trd', 'awaiting_trd_approval', 'planning',
    'executing', 'verifying', 'awaiting_acceptance', 'blocked', 'closed'
  )),
  outcome TEXT CHECK (outcome IN ('completed', 'cancelled')),
  goal TEXT NOT NULL,
  prd_id TEXT NOT NULL,
  prd_version TEXT NOT NULL,
  prd_digest TEXT NOT NULL,
  context_id TEXT,
  context_version TEXT,
  context_digest TEXT,
  trd_id TEXT,
  trd_version TEXT,
  trd_digest TEXT,
  blocked_reason TEXT,
  resume_to_status TEXT CHECK (resume_to_status IS NULL OR resume_to_status IN (
    'intake', 'contextualizing', 'drafting_trd', 'awaiting_trd_approval', 'planning',
    'executing', 'verifying', 'awaiting_acceptance'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK ((status = 'closed') = (outcome IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL AND resume_to_status IS NOT NULL)),
  CHECK ((context_id IS NULL AND context_version IS NULL AND context_digest IS NULL) OR
         (context_id IS NOT NULL AND context_version IS NOT NULL AND context_digest IS NOT NULL)),
  CHECK ((trd_id IS NULL AND trd_version IS NULL AND trd_digest IS NULL) OR
         (trd_id IS NOT NULL AND trd_version IS NOT NULL AND trd_digest IS NOT NULL)),
  FOREIGN KEY (prd_id, prd_version, prd_digest) REFERENCES artifacts(artifact_id, artifact_version, digest),
  FOREIGN KEY (context_id, context_version, context_digest) REFERENCES artifacts(artifact_id, artifact_version, digest),
  FOREIGN KEY (trd_id, trd_version, trd_digest) REFERENCES artifacts(artifact_id, artifact_version, digest)
) STRICT;

CREATE TABLE task_transitions (
  transition_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  command_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  from_version INTEGER,
  to_version INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_roles_json TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (task_id, command_id)
) STRICT;

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  version INTEGER NOT NULL CHECK (version > 0),
  gate_type TEXT NOT NULL CHECK (gate_type IN ('trd_approval', 'run_authorization')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_version TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  required_roles_json TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'approved', 'approved_with_conditions', 'changes_requested', 'rejected',
    'withdrawn', 'expired', 'revoked'
  )),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX one_pending_approval_per_subject
  ON approvals(gate_type, subject_type, subject_id, subject_version, subject_digest)
  WHERE status = 'pending';

CREATE TABLE approval_transitions (
  transition_id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES approvals(approval_id),
  command_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  from_version INTEGER,
  to_version INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_roles_json TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (approval_id, command_id)
) STRICT;

CREATE TABLE approval_decisions (
  decision_id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES approvals(approval_id),
  approval_version INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN (
    'approved', 'approved_with_conditions', 'changes_requested', 'rejected'
  )),
  authority_id TEXT NOT NULL,
  authority_role TEXT NOT NULL,
  reason TEXT NOT NULL,
  conditions_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  UNIQUE (approval_id, authority_id)
) STRICT;

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  version INTEGER NOT NULL CHECK (version > 0),
  manifest_digest TEXT NOT NULL UNIQUE,
  authorization_approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(approval_id),
  status TEXT NOT NULL CHECK (status IN (
    'awaiting_authorization', 'authorized', 'active', 'stopping', 'blocked', 'settled'
  )),
  outcome TEXT CHECK (outcome IN ('completed', 'cancelled', 'superseded', 'rejected', 'failed')),
  pending_outcome TEXT CHECK (pending_outcome IN ('cancelled', 'superseded', 'failed')),
  resume_to_status TEXT CHECK (resume_to_status IN ('authorized', 'active', 'stopping')),
  reason_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK (
    (status = 'stopping' AND pending_outcome IS NOT NULL AND reason_code IS NOT NULL AND resume_to_status IS NULL AND outcome IS NULL AND settled_at IS NULL) OR
    (status = 'blocked' AND resume_to_status IS NOT NULL AND reason_code IS NOT NULL AND pending_outcome IS NULL AND outcome IS NULL AND settled_at IS NULL) OR
    (status = 'settled' AND outcome IS NOT NULL AND settled_at IS NOT NULL AND pending_outcome IS NULL AND resume_to_status IS NULL AND reason_code IS NULL) OR
    (status IN ('awaiting_authorization', 'authorized', 'active') AND outcome IS NULL AND pending_outcome IS NULL AND resume_to_status IS NULL AND reason_code IS NULL AND settled_at IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX one_unsettled_run_per_task
  ON runs(task_id) WHERE status <> 'settled';

CREATE TABLE run_manifests (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  schema_version TEXT NOT NULL CHECK (schema_version = '1'),
  digest TEXT NOT NULL UNIQUE,
  canonical_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE run_transitions (
  transition_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  command_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  from_version INTEGER,
  to_version INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_roles_json TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (run_id, command_id)
) STRICT;

CREATE TABLE role_runs (
  role_run_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  role_plan_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('coordinator', 'executor', 'verifier')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'starting', 'running', 'settling', 'blocked', 'settled')),
  outcome TEXT CHECK (outcome IN ('succeeded', 'failed', 'aborted', 'interrupted')),
  runtime_outcome TEXT CHECK (runtime_outcome IN ('completed', 'error', 'aborted', 'incomplete', 'unknown')),
  session_id TEXT,
  input_artifacts_json TEXT NOT NULL,
  output_artifacts_json TEXT NOT NULL,
  tool_operation_refs_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  lease_token INTEGER NOT NULL CHECK (lease_token >= 0),
  prepared_at TEXT NOT NULL,
  started_at TEXT,
  runtime_ended_at TEXT,
  settled_at TEXT,
  error_code TEXT,
  sanitized_error TEXT,
  CHECK ((status = 'settled') = (outcome IS NOT NULL AND settled_at IS NOT NULL)),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  UNIQUE (run_id, attempt)
) STRICT;

CREATE UNIQUE INDEX one_unsettled_role_run_per_run
  ON role_runs(run_id) WHERE status <> 'settled';

CREATE TABLE role_run_transitions (
  transition_id TEXT PRIMARY KEY,
  role_run_id TEXT NOT NULL REFERENCES role_runs(role_run_id),
  command_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  from_version INTEGER,
  to_version INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_roles_json TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  lease_token INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (role_run_id, command_id)
) STRICT;

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  completed_at TEXT NOT NULL
) STRICT;

CREATE TABLE outbox (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')),
  created_at TEXT NOT NULL,
  delivered_at TEXT
) STRICT;

CREATE TRIGGER artifacts_immutable_update BEFORE UPDATE ON artifacts BEGIN
  SELECT RAISE(ABORT, 'artifacts are immutable');
END;
CREATE TRIGGER artifacts_immutable_delete BEFORE DELETE ON artifacts BEGIN
  SELECT RAISE(ABORT, 'artifacts are immutable');
END;
CREATE TRIGGER task_transitions_immutable_update BEFORE UPDATE ON task_transitions BEGIN
  SELECT RAISE(ABORT, 'task transitions are immutable');
END;
CREATE TRIGGER task_transitions_immutable_delete BEFORE DELETE ON task_transitions BEGIN
  SELECT RAISE(ABORT, 'task transitions are immutable');
END;
CREATE TRIGGER approval_transitions_immutable_update BEFORE UPDATE ON approval_transitions BEGIN
  SELECT RAISE(ABORT, 'approval transitions are immutable');
END;
CREATE TRIGGER approval_transitions_immutable_delete BEFORE DELETE ON approval_transitions BEGIN
  SELECT RAISE(ABORT, 'approval transitions are immutable');
END;
CREATE TRIGGER approval_decisions_immutable_update BEFORE UPDATE ON approval_decisions BEGIN
  SELECT RAISE(ABORT, 'approval decisions are immutable');
END;
CREATE TRIGGER approval_decisions_immutable_delete BEFORE DELETE ON approval_decisions BEGIN
  SELECT RAISE(ABORT, 'approval decisions are immutable');
END;
CREATE TRIGGER run_manifests_immutable_update BEFORE UPDATE ON run_manifests BEGIN
  SELECT RAISE(ABORT, 'run manifests are immutable');
END;
CREATE TRIGGER run_manifests_immutable_delete BEFORE DELETE ON run_manifests BEGIN
  SELECT RAISE(ABORT, 'run manifests are immutable');
END;
CREATE TRIGGER run_transitions_immutable_update BEFORE UPDATE ON run_transitions BEGIN
  SELECT RAISE(ABORT, 'run transitions are immutable');
END;
CREATE TRIGGER run_transitions_immutable_delete BEFORE DELETE ON run_transitions BEGIN
  SELECT RAISE(ABORT, 'run transitions are immutable');
END;
CREATE TRIGGER role_run_transitions_immutable_update BEFORE UPDATE ON role_run_transitions BEGIN
  SELECT RAISE(ABORT, 'role run transitions are immutable');
END;
CREATE TRIGGER role_run_transitions_immutable_delete BEFORE DELETE ON role_run_transitions BEGIN
  SELECT RAISE(ABORT, 'role run transitions are immutable');
END;
CREATE TRIGGER commands_immutable_update BEFORE UPDATE ON commands BEGIN
  SELECT RAISE(ABORT, 'commands are immutable');
END;
CREATE TRIGGER commands_immutable_delete BEFORE DELETE ON commands BEGIN
  SELECT RAISE(ABORT, 'commands are immutable');
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

  const findMigration = database.prepare(
    "SELECT digest FROM schema_migrations WHERE migration_id = ?",
  );
  const recordMigration = database.prepare(
    "INSERT INTO schema_migrations (migration_id, digest, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    const digest = sha256Digest(migration.sql);
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
