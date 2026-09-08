import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  canonicalizeJson,
  digestJson,
  normalizeRunManifest,
  SqliteControlPlane,
  type ApprovalCondition,
  type RecordApprovalDecisionCommand,
  type SealRunManifestCommand,
} from "../src/index.js";
import { TestClock, TestIds, authorizeRun, registerPrerequisites, type Prerequisites } from "./fixtures.js";

const TABLES = [
  "artifacts", "tasks", "task_transitions", "approvals", "approval_transitions", "approval_decisions",
  "runs", "run_manifests", "run_transitions", "role_runs", "role_run_transitions", "commands", "outbox",
] as const;

/** Reconstruct a database the previous release could write, without altering migrations or immutable rows. */
export function writeLegacyConditionalFixture(
  sourcePath: string,
  targetPath: string,
  mode: "conditional_approval" | "manifest_conditions",
  stage: "planning" | "authorized" = "authorized",
): Prerequisites {
  const source = new SqliteControlPlane({ databasePath: sourcePath, clock: new TestClock(), idGenerator: new TestIds() });
  const prerequisites = registerPrerequisites(source);
  authorizeRun(source, prerequisites);
  const originalTrdApproval = source.getApproval("approval-trd-1");
  const originalTrdRef = source.getApprovalRef("approval-trd-1");
  const originalAuthorization = source.getApproval("approval-run-1");
  const originalAuthorizationRef = source.getApprovalRef("approval-run-1");
  const originalManifest = source.getRunManifest("run-1");
  source.close();

  const condition: ApprovalCondition = {
    conditionId: "legacy-external-confirmation",
    description: "External confirmation remains outstanding",
    owner: "human-reviewer",
    requiredBefore: "execution",
    verificationMethod: "Review the signed confirmation",
    evidenceRefs: [],
  };
  const legacyTrdApproval = mode === "conditional_approval"
    ? { ...originalTrdApproval, status: "approved_with_conditions" as const }
    : originalTrdApproval;
  const legacyTrdDigest = digestJson(legacyTrdApproval);
  const legacyManifest = normalizeRunManifest({
    ...originalManifest.manifest,
    inputs: {
      ...originalManifest.manifest.inputs,
      prerequisiteApprovals: [{ ...originalTrdRef, digest: legacyTrdDigest }],
    },
    policies: {
      ...originalManifest.manifest.policies,
      // The original defect allowed an approved condition to be omitted from the Manifest.
      approvalConditions: mode === "manifest_conditions" ? [condition] : [],
    },
  });
  const legacyManifestDigest = digestJson(legacyManifest);
  const legacyAuthorization = {
    ...originalAuthorization,
    subject: { ...originalAuthorization.subject, digest: legacyManifestDigest },
  };
  const replacements = [
    [originalTrdRef.digest, legacyTrdDigest],
    [originalManifest.digest, legacyManifestDigest],
    [originalAuthorizationRef.digest, digestJson(legacyAuthorization)],
  ] as const;

  const oldReader = new DatabaseSync(sourcePath, { readOnly: true });
  const target = new SqliteControlPlane({ databasePath: targetPath, clock: new TestClock(), idGenerator: new TestIds() });
  target.close();
  const database = new DatabaseSync(targetPath);
  database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  try {
    for (const table of TABLES) {
      if (stage === "planning" && ["runs", "run_manifests", "run_transitions", "role_runs", "role_run_transitions"].includes(table)) continue;
      const rows = oldReader.prepare(`SELECT * FROM ${table}`).all();
      for (const original of rows) {
        if (stage === "planning" && (
          original.approval_id === "approval-run-1" ||
          (table === "task_transitions" && Number(original.to_version) > 5) ||
          (table === "commands" && ["seal-run", "approve-run"].includes(String(original.command_id))) ||
          (table === "outbox" && original.aggregate_id === "approval-run-1")
        )) continue;
        const row = Object.fromEntries(Object.entries(original).map(([key, value]) => [
          key,
          typeof value === "string"
            ? replacements.reduce((text, [before, after]) => text.replaceAll(before, after), value)
            : value,
        ]));
        if (stage === "planning" && table === "tasks") {
          row.status = "planning";
          row.version = 5;
        }
        if (table === "run_manifests") row.canonical_json = canonicalizeJson(legacyManifest);
        if (mode === "conditional_approval") {
          if (table === "approvals" && row.approval_id === "approval-trd-1") row.status = "approved_with_conditions";
          if (table === "approval_decisions" && row.approval_id === "approval-trd-1") {
            row.decision = "approved_with_conditions";
            row.conditions_json = canonicalizeJson([condition]);
          }
          if (table === "approval_transitions" && row.approval_id === "approval-trd-1" && row.to_status === "approved") {
            row.to_status = "approved_with_conditions";
            row.reason_code = "approval_approved_with_conditions";
          }
          if (table === "task_transitions" && row.reason_code === "trd_approved") row.reason_code = "trd_approved_with_conditions";
        }
        if (table === "commands" && row.command_id === "approve-trd" && mode === "conditional_approval") {
          const request: RecordApprovalDecisionCommand = {
            commandId: "approve-trd", actor: { actorId: "human-architect", actorType: "human", roles: ["architecture_authority"] },
            approvalId: "approval-trd-1", expectedApprovalVersion: 1, expectedTaskVersion: 4,
            decisionId: "decision-trd-1", authorityRole: "architecture_authority", decision: "approved_with_conditions",
            reason: "Design meets the accepted control", conditions: [condition], evidenceRefs: ["architecture-review"],
          };
          row.request_digest = digestJson({ commandType: "record_approval_decision", request });
          const result = JSON.parse(row.result_json as string) as Record<string, unknown>;
          row.result_json = canonicalizeJson({ ...result, approval: legacyTrdApproval });
        }
        if (table === "commands" && row.command_id === "seal-run") {
          const request: SealRunManifestCommand = {
            commandId: "seal-run", actor: { actorId: "agent-coordinator", actorType: "agent", roles: ["coordinator"] },
            taskId: "task-1", expectedTaskVersion: 5, runId: "run-1", manifest: legacyManifest,
            authorizationApprovalId: "approval-run-1", authorizationPolicyVersion: "run-policy-1",
            requiredAuthorizationRoles: ["delivery_authority"],
          };
          row.request_digest = digestJson({ commandType: "seal_run_manifest", request });
        }
        const columns = Object.keys(row);
        database.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
          .run(...Object.values(row) as SQLInputValue[]);
      }
    }
    database.exec("COMMIT");
    if (database.prepare("PRAGMA foreign_key_check").all().length > 0) throw new Error("Legacy fixture has broken foreign keys");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
    oldReader.close();
  }
  return prerequisites;
}
