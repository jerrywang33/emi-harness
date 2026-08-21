import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  AssuranceError,
  formatEvidenceRef,
  sha256Text,
  SqliteEvidenceStore,
  type Clock,
  type EvidenceRecordInput,
} from "../src/index.js";

const directories: string[] = [];
const clock: Clock = { now: () => "2026-08-21T00:00:00.000Z" };

function input(content: EvidenceRecordInput["content"] = { result: "passed" }): EvidenceRecordInput {
  return {
    evidenceId: "evidence-check-1",
    version: "1",
    kind: "check_result",
    taskId: "task-1",
    runId: "run-1",
    roleRunId: "role-verifier-1",
    producer: { producerId: "assurance.node-check-runner", producerType: "system" },
    subjectRefs: [
      { id: "check-1", version: "1", digest: `sha256:${"1".repeat(64)}` },
    ],
    content,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SqliteEvidenceStore", () => {
  it("persists a digest-bound immutable Evidence envelope and reopens it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "emi-evidence-"));
    directories.push(directory);
    const databasePath = join(directory, "evidence.sqlite");
    const store = new SqliteEvidenceStore({ databasePath, clock });
    const record = store.put(input());
    expect(sha256Text(record.canonicalJson)).toBe(record.digest);
    expect(formatEvidenceRef(record)).toBe(`evidence:evidence-check-1@1#${record.digest}`);
    expect(store.put(input())).toEqual(record);
    store.close();

    const raw = new DatabaseSync(databasePath);
    expect(() => raw.prepare("UPDATE evidence_records SET canonical_json = '{}' WHERE evidence_id = ?").run(
      record.evidenceId,
    )).toThrow(/evidence records are immutable/);
    raw.close();

    const reopened = new SqliteEvidenceStore({ databasePath, clock });
    expect(reopened.get({ id: record.evidenceId, version: record.version, digest: record.digest })).toEqual(record);
    expect(reopened.listForRun("run-1")).toEqual([record]);
    reopened.close();
  });

  it("rejects reuse of an Evidence identity with different content", () => {
    const store = new SqliteEvidenceStore({ databasePath: ":memory:", clock });
    store.put(input());
    expect(() => store.put(input({ result: "failed" }))).toThrowError(
      expect.objectContaining<Partial<AssuranceError>>({ code: "evidence_conflict" }),
    );
    store.close();
  });
});
