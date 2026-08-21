import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { IsolatedToolExecutorPort } from "@emi-harness/tool-gateway";

import { SUBMIT_EXECUTION_TOOL_REF, SUBMIT_VERIFICATION_TOOL_REF } from "../src/index.js";
import { createHarnessFixture, executorWorker, verifierWorker } from "./fixtures.js";

describe("RoleExecutionCoordinator", () => {
  it("runs separate Executor and Verifier sessions and stops at user acceptance", async () => {
    const fixture = await createHarnessFixture();
    try {
      const execution = await fixture.coordinator.execute({
        taskId: "task-1",
        runId: "run-1",
        roleRunId: "role-executor-1",
        rolePlanId: "executor-plan",
        cwd: fixture.root,
        prompt: "Implement the approved safeguarded status change.",
        worker: executorWorker,
        executionResultId: "execution-result-1",
      });
      expect(execution.status).toBe("completed");
      if (execution.status !== "completed") throw new Error("Executor failed");
      expect(execution.task.status).toBe("verifying");
      expect(await readFile(join(fixture.root, "src/status.ts"), "utf8")).toContain("safeguarded");

      const verification = await fixture.coordinator.verify({
        taskId: "task-1",
        runId: "run-1",
        roleRunId: "role-verifier-1",
        rolePlanId: "verifier-plan",
        cwd: fixture.root,
        prompt: "Verify the bound execution result using the authoritative checks.",
        worker: verifierWorker,
        executionResult: execution.executionResult,
        executorRoleRunId: execution.roleRun.roleRunId,
        verificationResultId: "verification-result-1",
      });
      expect(verification.status).toBe("completed");
      if (verification.status !== "completed") throw new Error("Verifier failed");
      expect(verification.task.status).toBe("awaiting_acceptance");
      expect(verification.task.outcome).toBeUndefined();
      expect(execution.sessionId).not.toBe(verification.sessionId);
      expect(fixture.runtime.starts).toHaveLength(2);
      expect(fixture.runtime.starts[0]?.tools.map((tool) => tool.name).sort()).toEqual([
        "workspace.write_text",
        SUBMIT_EXECUTION_TOOL_REF.name,
      ].sort());
      expect(fixture.runtime.starts[1]?.tools.map((tool) => tool.name)).toEqual([
        SUBMIT_VERIFICATION_TOOL_REF.name,
      ]);
      expect(fixture.runtime.starts[0]?.resources.contextFiles?.map((resource) => resource.source)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^emi-artifact:trd:trd-1@1#sha256:/),
          expect.stringMatching(/^emi-artifact:execution_plan:execution-plan-1@1#sha256:/),
          expect.stringMatching(/^emi-artifact:acceptance_criteria:acceptance-criteria-1@1#sha256:/),
        ]),
      );
      expect(fixture.runtime.starts[1]?.resources.contextFiles?.map((resource) => resource.source)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^emi-artifact:execution_result:execution-result-1@1#sha256:/),
          expect.stringMatching(/^emi-artifact:acceptance_criteria:acceptance-criteria-1@1#sha256:/),
        ]),
      );
      expect(JSON.stringify(fixture.runtime.starts.map((start) => start.resources))).not.toContain(
        "AMBIENT_RESOURCE_MUST_NOT_LOAD",
      );
      expect(fixture.evidence.listForRun("run-1").map((record) => record.kind).sort()).toEqual([
        "check_result",
        "execution",
        "runtime",
        "runtime",
        "tool_operation",
        "verification_assurance",
      ].sort());
    } finally {
      await fixture.close();
    }
  });

  it("routes an independently reported implementation failure back to executing", async () => {
    const fixture = await createHarnessFixture({
      checkPasses: false,
      verifierCalls: [
        {
          callId: "submit-verification",
          name: SUBMIT_VERIFICATION_TOOL_REF.name,
          input: {
            verdict: "fail",
            findingClass: "implementation",
            reason: "Required implementation check failed",
            findings: ["check-1 failed"],
          },
        },
      ],
    });
    try {
      const execution = await fixture.coordinator.execute({
        taskId: "task-1",
        runId: "run-1",
        roleRunId: "role-executor-1",
        rolePlanId: "executor-plan",
        cwd: fixture.root,
        prompt: "Implement.",
        worker: executorWorker,
        executionResultId: "execution-result-1",
      });
      if (execution.status !== "completed") throw new Error("Executor failed");
      const verification = await fixture.coordinator.verify({
        taskId: "task-1",
        runId: "run-1",
        roleRunId: "role-verifier-1",
        rolePlanId: "verifier-plan",
        cwd: fixture.root,
        prompt: "Verify.",
        worker: verifierWorker,
        executionResult: execution.executionResult,
        executorRoleRunId: execution.roleRun.roleRunId,
        verificationResultId: "verification-result-1",
      });
      expect(verification.status).toBe("completed");
      expect(verification.task.status).toBe("executing");
      expect(verification.roleRun).toMatchObject({ status: "settled", outcome: "succeeded" });
    } finally {
      await fixture.close();
    }
  });

  it("rejects a Verifier PASS when the required check failed", async () => {
    const fixture = await createHarnessFixture({ checkPasses: false });
    try {
      const execution = await fixture.coordinator.execute({
        taskId: "task-1",
        runId: "run-1",
        roleRunId: "role-executor-1",
        rolePlanId: "executor-plan",
        cwd: fixture.root,
        prompt: "Implement.",
        worker: executorWorker,
        executionResultId: "execution-result-1",
      });
      if (execution.status !== "completed") throw new Error("Executor failed");
      const verification = await fixture.coordinator.verify({
        taskId: "task-1",
        runId: "run-1",
        roleRunId: "role-verifier-1",
        rolePlanId: "verifier-plan",
        cwd: fixture.root,
        prompt: "Verify.",
        worker: verifierWorker,
        executionResult: execution.executionResult,
        executorRoleRunId: execution.roleRun.roleRunId,
        verificationResultId: "verification-result-1",
      });
      expect(verification).toMatchObject({ status: "failed", errorCode: "assurance_rejected" });
      expect(fixture.controlPlane.getTask("task-1").status).toBe("verifying");
      expect(fixture.controlPlane.getRoleRun("role-verifier-1")).toMatchObject({ status: "settled", outcome: "failed" });
    } finally {
      await fixture.close();
    }
  });

  it("blocks the Task, Run, and Executor when a tool operation remains unknown", async () => {
    const unknownExecutor: IsolatedToolExecutorPort = {
      async execute() {
        throw new Error("worker connection lost after dispatch");
      },
      async reconcile() {
        return {
          outcome: "unknown",
          output: { observed: "indeterminate" },
          evidenceRefs: ["reconciliation-observation"],
          errorCode: "target_state_indeterminate",
          sanitizedError: "Target state cannot prove whether the write was applied",
        };
      },
    };
    const fixture = await createHarnessFixture({ executor: unknownExecutor, executorOutcome: "error" });
    try {
      const execution = await fixture.coordinator.execute({
        taskId: "task-1",
        runId: "run-1",
        roleRunId: "role-executor-1",
        rolePlanId: "executor-plan",
        cwd: fixture.root,
        prompt: "Implement.",
        worker: executorWorker,
        executionResultId: "execution-result-1",
      });
      expect(execution).toMatchObject({
        status: "blocked",
        errorCode: "unknown_tool_operation",
        task: { status: "blocked", resumeToStatus: "executing" },
        run: { status: "blocked", resumeToStatus: "active" },
        roleRun: { status: "blocked", errorCode: "unknown_tool_operation" },
      });
      const operationEvidence = fixture.evidence.listForRun("run-1").find((record) => record.kind === "tool_operation");
      expect(operationEvidence?.content).toMatchObject({ status: "unknown" });
    } finally {
      await fixture.close();
    }
  });
});
