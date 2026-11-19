import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { sha256Text } from "@emi-harness/canonical-json";

/** A forward-only migration. Its SQL text is pinned by digest once applied. */
export interface LedgerMigration {
  id: string;
  sql: string;
}

export interface OpenLedgerDatabaseOptions {
  databasePath: string;
  migrations: readonly LedgerMigration[];
  now: () => string;
}

const MEMORY_DATABASE = ":memory:";

/**
 * Opens a single-writer ledger with the settings required by ADR 0003, applies pending
 * migrations and restricts a newly created database file to its owner.
 */
export function openLedgerDatabase(options: OpenLedgerDatabaseOptions): DatabaseSync {
  const persistent = options.databasePath !== MEMORY_DATABASE;
  const existed = persistent && existsSync(options.databasePath);
  const database = new DatabaseSync(options.databasePath, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    applyMigrations(database, options.migrations, options.now);
    if (persistent && !existed) {
      chmodSync(options.databasePath, 0o600);
    }
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

/** Runs action inside BEGIN IMMEDIATE; a failed rollback never masks the original error. */
export function inTransaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The original error is more useful when SQLite already rolled back the transaction.
    }
    throw error;
  }
}

export function applyMigrations(database: DatabaseSync, migrations: readonly LedgerMigration[], now: () => string): void {
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
  for (const migration of migrations) {
    const digest = sha256Text(migration.sql);
    const existing = findMigration.get(migration.id) as { digest: string } | undefined;
    if (existing !== undefined) {
      if (existing.digest !== digest) {
        throw new Error(`Applied migration digest mismatch: ${migration.id}`);
      }
      continue;
    }
    inTransaction(database, () => {
      database.exec(migration.sql);
      recordMigration.run(migration.id, digest, now());
    });
  }
}
