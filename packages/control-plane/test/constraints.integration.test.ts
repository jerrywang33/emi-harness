import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneError, SqliteControlPlane } from "../src/index.js";
import {
  TestClock,
  TestIds,
  advanceToPlanning,
  artifact,
  coordinator,
  manifest,
  ref,
  registerPrerequisites,
} from "./fixtures.js";

const directories: string[] = [];

async function fixture(): Promise<{ path: string; clock: TestClock; controlPlane: SqliteControlPlane }> {
  const directory = await mkdtemp(join(tmpdir(), "emi-control-constraints-"));
  directories.push(directory);
  const path = join(directory, "state.db");
  const clock = new TestClock();
  return {
    path,
    clock,
    controlPlane: new SqliteControlPlane({ databasePath: path, clock, idGenerator: new TestIds() }),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Control Plane database constraints", () => {
  it("rejects a second unsettled Run and rolls back its Approval", async () => {
    const { controlPlane } = await fixture();
    const prerequisites = registerPrerequisites(controlPlane);
    const trdApproval = advanceToPlanning(controlPlane, prerequisites);
    controlPlane.sealRunManifest({
      commandId: "seal-run-1",
      actor: coordinator,
      taskId: "task-1",
      expectedTaskVersion: 5,
      runId: "run-1",
      manifest: manifest(5, prerequisites, trdApproval),
      authorizationApprovalId: "approval-run-1",
      authorizationPolicyVersion: "run-policy-1",
      requiredAuthorizationRoles: ["delivery_authority"],
    });
    const secondManifest = { ...manifest(5, prerequisites, trdApproval), runId: "run-2" };
    expect(() =>
      controlPlane.sealRunManifest({
        commandId: "seal-run-2",
        actor: coordinator,
        taskId: "task-1",
        expectedTaskVersion: 5,
        runId: "run-2",
        manifest: secondManifest,
        authorizationApprovalId: "approval-run-2",
        authorizationPolicyVersion: "run-policy-1",
        requiredAuthorizationRoles: ["delivery_authority"],
      }),
    ).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "already_exists" }));
    expect(() => controlPlane.getApproval("approval-run-2")).toThrowError(
      expect.objectContaining<Partial<ControlPlaneError>>({ code: "not_found" }),
    );
    controlPlane.close();
  });

  it("rejects Command ID reuse with different input and database mutation of immutable artifacts", async () => {
    const { path, controlPlane } = await fixture();
    const first = artifact("artifact-1", "prd", { goal: "first" });
    controlPlane.registerArtifact({ commandId: "artifact-command", actor: coordinator, artifact: first });
    expect(() =>
      controlPlane.registerArtifact({
        commandId: "artifact-command",
        actor: coordinator,
        artifact: artifact("artifact-1", "prd", { goal: "different" }),
      }),
    ).toThrowError(expect.objectContaining<Partial<ControlPlaneError>>({ code: "command_conflict" }));
    controlPlane.close();

    const raw = new DatabaseSync(path);
    expect(() => raw.prepare("UPDATE artifacts SET kind = 'changed' WHERE artifact_id = ?").run(first.id)).toThrow(
      "artifacts are immutable",
    );
    raw.close();
  });

  it("expires a pending Approval using the controlled clock and returns the Task for revision", async () => {
    const { clock, controlPlane } = await fixture();
    const prerequisites = registerPrerequisites(controlPlane);
    controlPlane.createTask({ commandId: "create", actor: coordinator, taskId: "task-1", goal: "Goal", prd: ref(prerequisites.prd) });
    controlPlane.startContextualization({ commandId: "start", actor: coordinator, taskId: "task-1", expectedTaskVersion: 1, reason: "ready" });
    controlPlane.completeContextualization({ commandId: "context", actor: coordinator, taskId: "task-1", expectedTaskVersion: 2, contextManifest: ref(prerequisites.context), evidenceRefs: [] });
    controlPlane.submitTrdForApproval({
      commandId: "submit",
      actor: coordinator,
      taskId: "task-1",
      expectedTaskVersion: 3,
      trd: ref(prerequisites.trd),
      approvalId: "approval-expiring",
      policyVersion: "approval-policy-1",
      requiredRoles: ["architecture_authority"],
      expiresAt: "2026-08-21T00:00:01.000Z",
    });
    clock.advance(1_001);
    const result = controlPlane.invalidateApproval({
      commandId: "expire",
      actor: { actorId: "approval-clock", actorType: "system", roles: [] },
      approvalId: "approval-expiring",
      expectedApprovalVersion: 1,
      expectedTaskVersion: 4,
      action: "expired",
      reasonCode: "approval_deadline_elapsed",
      evidenceRefs: [],
    });
    expect(result.approval.status).toBe("expired");
    expect(result.task).toMatchObject({ status: "drafting_trd", version: 5 });
    controlPlane.close();
  });
});
