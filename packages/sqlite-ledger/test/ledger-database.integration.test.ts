import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sha256Text } from "@emi-harness/canonical-json";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asNumber, asText, inTransaction, openLedgerDatabase, optionalField, optionalNumber, optionalText, type SqlRow } from "../src/index.js";

const now = () => "2026-11-19T00:00:00.000Z";
const migrations = [
  { id: "0001_items", sql: "CREATE TABLE items (id TEXT PRIMARY KEY, n INTEGER) STRICT;" },
  { id: "0002_notes", sql: "CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT) STRICT;" },
];

describe("openLedgerDatabase", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sqlite-ledger-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("applies pinned migrations once, enforces ledger settings and restricts new files", async () => {
    const path = join(root, "ledger.sqlite");
    const first = openLedgerDatabase({ databasePath: path, migrations, now });
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(first.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(first.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    first.close();
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const reopened = openLedgerDatabase({ databasePath: path, migrations, now });
    expect(reopened.prepare("SELECT migration_id, digest FROM schema_migrations ORDER BY migration_id").all()).toEqual(
      migrations.map((migration) => ({ migration_id: migration.id, digest: sha256Text(migration.sql) })),
    );
    reopened.close();
  });

  it("refuses to open a ledger whose applied migration was rewritten", () => {
    const path = join(root, "ledger.sqlite");
    openLedgerDatabase({ databasePath: path, migrations, now }).close();
    const rewritten = [{ ...migrations[0]!, sql: `${migrations[0]!.sql} ` }, migrations[1]!];
    expect(() => openLedgerDatabase({ databasePath: path, migrations: rewritten, now })).toThrow(
      "Applied migration digest mismatch: 0001_items",
    );
  });

  it("rolls back a failed migration without recording it", () => {
    const path = join(root, "ledger.sqlite");
    const broken = [migrations[0]!, { id: "0002_broken", sql: "CREATE TABLE broken (id TEXT) STRICT; INSERT INTO missing VALUES (1);" }];
    expect(() => openLedgerDatabase({ databasePath: path, migrations: broken, now })).toThrow();
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT migration_id FROM schema_migrations").all()).toEqual([{ migration_id: "0001_items" }]);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'broken'").all()).toEqual([]);
    raw.close();
  });
});

describe("inTransaction", () => {
  it("commits results and rolls back on error while keeping the original error", () => {
    const database = openLedgerDatabase({ databasePath: ":memory:", migrations, now });
    expect(inTransaction(database, () => {
      database.prepare("INSERT INTO items (id, n) VALUES ('a', 1)").run();
      return "done";
    })).toBe("done");
    expect(() => inTransaction(database, () => {
      database.prepare("INSERT INTO items (id, n) VALUES ('b', 2)").run();
      throw new Error("original failure");
    })).toThrow("original failure");
    expect(() => inTransaction(database, () => {
      database.exec("ROLLBACK");
      throw new Error("after manual rollback");
    })).toThrow("after manual rollback");
    expect(database.prepare("SELECT id FROM items ORDER BY id").all()).toEqual([{ id: "a" }]);
    database.close();
  });
});

describe("row readers", () => {
  it("checks column types and omits missing optional values", () => {
    const row: SqlRow = { text: "x", count: 3, missing: null };
    expect(asText(row, "text")).toBe("x");
    expect(asNumber(row, "count")).toBe(3);
    expect(optionalText(row, "missing")).toBeUndefined();
    expect(optionalNumber(row, "missing")).toBeUndefined();
    expect(() => asText(row, "count")).toThrow("Expected text column: count");
    expect(() => asNumber(row, "text")).toThrow("Expected numeric column: text");
    expect({ ...optionalField("a", undefined), ...optionalField("b", 1) }).toEqual({ b: 1 });
  });
});
