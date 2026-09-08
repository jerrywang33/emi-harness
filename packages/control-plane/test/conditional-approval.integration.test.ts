import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneError, SqliteControlPlane, digestJson, type ApprovalCondition } from "../src/index.js";
import { writeLegacyConditionalFixture } from "./legacy-conditional-fixture.js";
import {
  TestClock,
  TestIds,
  advanceToPlanning,
  architect,
  coordinator,
  deliveryAuthority,
  manifest,
  ref,
  registerPrerequisites,
  type Prerequisites,
} from "./fixtures.js";

const fixtures: { directory: string; controlPlane: SqliteControlPlane }[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "emi-conditional-approval-"));
  const path = join(directory, "state.db");
  const controlPlane = new SqliteControlPlane({
    databasePath: path,
    clock: new TestClock(),
    idGenerator: new TestIds(),
  });
  fixtures.push({ directory, controlPlane });
  return { path, controlPlane, prerequisites: registerPrerequisites(controlPlane) };
}

afterEach(async () => {
  for (const { directory, controlPlane } of fixtures.splice(0)) {
    controlPlane.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function awaitTrdApproval(controlPlane: SqliteControlPlane, prerequisites: Prerequisites): void {
  controlPlane.createTask({ commandId: "create-task", actor: coordinator, taskId: "task-1", goal: "Goal", prd: ref(prerequisites.prd) });
  controlPlane.startContextualization({ commandId: "start-context", actor: coordinator, taskId: "task-1", expectedTaskVersion: 1, reason: "Ready" });
  controlPlane.completeContextualization({ commandId: "complete-context", actor: coordinator, taskId: "task-1", expectedTaskVersion: 2, contextManifest: ref(prerequisites.context), evidenceRefs: [] });
  controlPlane.submitTrdForApproval({
    commandId: "submit-trd",
    actor: coordinator,
    taskId: "task-1",
    expectedTaskVersion: 3,
    trd: ref(prerequisites.trd),
    approvalId: "approval-trd-1",
    policyVersion: "approval-policy-1",
    requiredRoles: ["architecture_authority"],
  });
}

function approveTrdCommand() {
  return {
    commandId: "approve-trd",
    actor: architect,
    approvalId: "approval-trd-1",
    expectedApprovalVersion: 1,
    expectedTaskVersion: 4,
    decisionId: "decision-trd-1",
    authorityRole: "architecture_authority",
    decision: "approved" as const,
    reason: "Design approved without outstanding conditions",
    conditions: [],
    evidenceRefs: ["architecture-review"],
  };
}

function condition(requiredBefore: ApprovalCondition["requiredBefore"], withEvidence: boolean): ApprovalCondition {
  return {
    conditionId: "external-confirmation",
    description: "Confirm the external prerequisite",
    owner: "human-reviewer",
    requiredBefore,
    verificationMethod: "Review the signed confirmation",
    evidenceRefs: withEvidence ? ["signed-confirmation"] : [],
  };
}

const conditionCases = (["planning", "execution", "acceptance"] as const).flatMap((requiredBefore) =>
  [false, true].map((withEvidence) => ({ requiredBefore, withEvidence })),
);

function ledgerCounts(path: string): Record<string, number> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries([
      "approvals", "approval_decisions", "approval_transitions", "task_transitions",
      "runs", "run_manifests", "run_transitions", "role_runs", "role_run_transitions", "commands", "outbox",
    ].map((table) => [table, (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count]));
  } finally {
    database.close();
  }
}

async function legacyFixture(mode: "conditional_approval" | "manifest_conditions", stage: "planning" | "authorized" = "authorized") {
  const directory = await mkdtemp(join(tmpdir(), "emi-legacy-conditional-"));
  const path = join(directory, "historical.db");
  const prerequisites = writeLegacyConditionalFixture(join(directory, "source.db"), path, mode, stage);
  const controlPlane = new SqliteControlPlane({ databasePath: path, clock: new TestClock(), idGenerator: new TestIds() });
  fixtures.push({ directory, controlPlane });
  return { path, controlPlane, prerequisites };
}

describe("v0.1 unconditional approval boundary", () => {
  it.each(conditionCases)("rejects $requiredBefore conditional TRD approval with evidence=$withEvidence without changing the ledger", async ({ requiredBefore, withEvidence }) => {
    const { path, controlPlane, prerequisites } = await fixture();
    awaitTrdApproval(controlPlane, prerequisites);
    const before = ledgerCounts(path);
    expect(() => controlPlane.recordApprovalDecision({
      ...approveTrdCommand(),
      decision: "approved_with_conditions",
      conditions: [condition(requiredBefore, withEvidence)],
    })).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "invalid_input" }));
    expect(ledgerCounts(path)).toEqual(before);
    expect(controlPlane.getTask("task-1")).toMatchObject({ status: "awaiting_trd_approval", version: 4 });
    expect(controlPlane.getApproval("approval-trd-1")).toMatchObject({ status: "pending", version: 1 });
    expect(controlPlane.listApprovalDecisions("approval-trd-1")).toEqual([]);

    // A rejected command did not consume either its Command ID or Decision ID.
    const approved = controlPlane.recordApprovalDecision(approveTrdCommand());
    expect(approved.task).toMatchObject({ status: "planning", version: 5 });
    expect(approved.approval).toMatchObject({ status: "approved", version: 2 });
    expect(controlPlane.listApprovalDecisions("approval-trd-1")).toHaveLength(1);
  });

  it("rejects approved_with_conditions even when no conditions are supplied", async () => {
    const { path, controlPlane, prerequisites } = await fixture();
    awaitTrdApproval(controlPlane, prerequisites);
    const before = ledgerCounts(path);
    expect(() => controlPlane.recordApprovalDecision({
      ...approveTrdCommand(), decision: "approved_with_conditions",
    })).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "invalid_input" }));
    expect(ledgerCounts(path)).toEqual(before);
    expect(controlPlane.recordApprovalDecision(approveTrdCommand()).approval.status).toBe("approved");
  });

  it("rejects conditions hidden in a plain approved decision", async () => {
    const { path, controlPlane, prerequisites } = await fixture();
    awaitTrdApproval(controlPlane, prerequisites);
    const before = ledgerCounts(path);
    expect(() => controlPlane.recordApprovalDecision({
      ...approveTrdCommand(), conditions: [condition("execution", true)],
    })).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "invalid_input" }));
    expect(ledgerCounts(path)).toEqual(before);
    expect(controlPlane.recordApprovalDecision(approveTrdCommand()).task.status).toBe("planning");
  });

  it.each(conditionCases)("rejects a Manifest with $requiredBefore conditions and evidence=$withEvidence before creating Run authorization", async ({ requiredBefore, withEvidence }) => {
    const { path, controlPlane, prerequisites } = await fixture();
    const trdApproval = advanceToPlanning(controlPlane, prerequisites);
    const runManifest = manifest(5, prerequisites, trdApproval);
    const command = {
      commandId: "seal-run",
      actor: coordinator,
      taskId: "task-1",
      expectedTaskVersion: 5,
      runId: "run-1",
      manifest: runManifest,
      authorizationApprovalId: "approval-run-1",
      authorizationPolicyVersion: "run-policy-1",
      requiredAuthorizationRoles: ["delivery_authority"],
    };
    const before = ledgerCounts(path);
    expect(() => controlPlane.sealRunManifest({
      ...command,
      manifest: { ...runManifest, policies: { ...runManifest.policies, approvalConditions: [condition(requiredBefore, withEvidence)] } },
    })).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "invalid_input" }));
    expect(ledgerCounts(path)).toEqual(before);
    expect(controlPlane.getTask("task-1")).toMatchObject({ status: "planning", version: 5 });
    expect(() => controlPlane.getRun("run-1")).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "not_found" }));
    expect(() => controlPlane.getApproval("approval-run-1")).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "not_found" }));
    expect(controlPlane.sealRunManifest(command).run.status).toBe("awaiting_authorization");
  });

  it("keeps Run authorization pending after conditional approval is rejected and accepts a later unconditional decision", async () => {
    const { path, controlPlane, prerequisites } = await fixture();
    const trdApproval = advanceToPlanning(controlPlane, prerequisites);
    controlPlane.sealRunManifest({
      commandId: "seal-run", actor: coordinator, taskId: "task-1", expectedTaskVersion: 5,
      runId: "run-1", manifest: manifest(5, prerequisites, trdApproval),
      authorizationApprovalId: "approval-run-1", authorizationPolicyVersion: "run-policy-1",
      requiredAuthorizationRoles: ["delivery_authority"],
    });
    const command = {
      commandId: "approve-run", actor: deliveryAuthority, approvalId: "approval-run-1",
      expectedApprovalVersion: 1, expectedTaskVersion: 5, expectedRunVersion: 1,
      decisionId: "decision-run-1", authorityRole: "delivery_authority", decision: "approved" as const,
      reason: "Run approved without outstanding conditions", conditions: [], evidenceRefs: ["run-review"],
    };
    const before = ledgerCounts(path);
    expect(() => controlPlane.recordApprovalDecision({
      ...command, decision: "approved_with_conditions", conditions: [condition("acceptance", true)],
    })).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "invalid_input" }));
    expect(ledgerCounts(path)).toEqual(before);
    expect(controlPlane.getRun("run-1")).toMatchObject({ status: "awaiting_authorization", version: 1 });
    const approved = controlPlane.recordApprovalDecision(command);
    expect(approved.task.status).toBe("executing");
    expect(approved.run?.status).toBe("authorized");
  });

  it("reads historical conditional TRD approval but rejects using it to seal a new Run", async () => {
    const { path, controlPlane, prerequisites } = await legacyFixture("conditional_approval", "planning");
    const before = ledgerCounts(path);
    const approval = controlPlane.getApproval("approval-trd-1");
    expect(approval.status).toBe("approved_with_conditions");
    expect(controlPlane.listApprovalDecisions(approval.approvalId)).toEqual([
      expect.objectContaining({ decision: "approved_with_conditions", conditions: [expect.objectContaining({ requiredBefore: "execution", evidenceRefs: [] })] }),
    ]);
    expect(controlPlane.listTaskTransitions("task-1")).toHaveLength(5);
    expect(ledgerCounts(path)).toEqual(before);
    expect(() => controlPlane.sealRunManifest({
      commandId: "new-seal-run", actor: coordinator, taskId: "task-1", expectedTaskVersion: 5,
      runId: "run-1", manifest: manifest(5, prerequisites, controlPlane.getApprovalRef("approval-trd-1")),
      authorizationApprovalId: "approval-run-1", authorizationPolicyVersion: "run-policy-1",
      requiredAuthorizationRoles: ["delivery_authority"],
    })).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "approval_invalid" }));
    expect(ledgerCounts(path)).toEqual(before);
    expect(controlPlane.getTask("task-1")).toMatchObject({ status: "planning", version: 5 });
  });

  it.each(["conditional_approval", "manifest_conditions"] as const)("preserves readable historical %s records while refusing authorization and new RoleRuns", async (mode) => {
    const { path, controlPlane, prerequisites } = await legacyFixture(mode);
    const before = ledgerCounts(path);
    const run = controlPlane.getRun("run-1");
    const stored = controlPlane.getRunManifest(run.runId);
    expect(run).toMatchObject({ status: "authorized", version: 2, manifestDigest: stored.digest });
    expect(digestJson(stored.manifest)).toBe(stored.digest);
    expect(stored.manifest.inputs.prerequisiteApprovals).toEqual([controlPlane.getApprovalRef("approval-trd-1")]);
    expect(controlPlane.getApproval("approval-run-1").subject.digest).toBe(stored.digest);
    expect(controlPlane.listApprovalDecisions("approval-trd-1")).toHaveLength(1);
    expect(controlPlane.listRunTransitions(run.runId)).toHaveLength(2);
    expect(controlPlane.listRoleRuns(run.runId)).toEqual([]);
    expect(ledgerCounts(path)).toEqual(before);

    expect(() => controlPlane.assertRunAuthorization(run.runId)).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "approval_invalid" }),
    );
    expect(() => controlPlane.prepareRoleRun({
      commandId: "prepare-from-legacy-run", actor: coordinator, taskId: "task-1", expectedTaskVersion: 6,
      runId: run.runId, expectedRunVersion: 2, roleRunId: "role-executor-1", rolePlanId: "executor-plan",
      inputArtifacts: [ref(prerequisites.trd)],
    })).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "approval_invalid" }));
    expect(ledgerCounts(path)).toEqual(before);
    expect(controlPlane.getRun(run.runId)).toEqual(run);
    expect(controlPlane.getTask("task-1")).toMatchObject({ status: "executing", version: 6 });
  });
});
