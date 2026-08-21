import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { SqliteEvidenceStore } from "@emi-harness/assurance";
import { digestJson, SqliteControlPlane, type VersionedRef } from "@emi-harness/control-plane";
import {
  DETERMINISTIC_PI_MODEL,
  DeterministicPiRuntimeAdapter,
} from "@emi-harness/runtime-pi/testing";
import {
  ControlPlaneRoleRunAuthority,
  SqliteToolGateway,
  SubprocessWorkspaceExecutor,
  WORKSPACE_WRITE_TOOL,
  WORKSPACE_WRITE_TOOL_REF,
  WorkspaceWritePolicy,
} from "@emi-harness/tool-gateway";
import { describe, expect, it } from "vitest";

import {
  CandidateEvidencePackageBuilder,
  parseCandidateEvidencePackage,
  serializeCandidateEvidencePackage,
  SUBMIT_EXECUTION_TOOL_REF,
  SUBMIT_VERIFICATION_TOOL_REF,
  writeCandidateEvidencePackage,
} from "../src/index.js";
import {
  createHarnessFixture,
  executorWorker,
  TestClock,
  TestIds,
  verifierWorker,
  type HarnessFixture,
} from "./fixtures.js";

const execFileAsync = promisify(execFile);

describe("local TypeScript target with Pi AgentSession", () => {
  it("recovers a known Executor failure and produces independently verified evidence", async () => {
    const configuredTarget = process.env.EMI_HARNESS_E2E_TARGET_ROOT;
    const harnessCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: join(import.meta.dirname, "../../.."),
    })).stdout.trim();
    const versionedRuntimeRef = (id: string, version: string, integrity: string): VersionedRef => ({
      id,
      version,
      digest: digestJson({ id, version, integrity }),
    });
    const agentRoot = await mkdtemp(join(tmpdir(), "emi-pi-e2e-agent-"));
    const runtime = await DeterministicPiRuntimeAdapter.create({
      agentDir: join(agentRoot, "agent"),
      scripts: [
        {
          roleRunId: "role-executor-1",
          responses: [
            {
              type: "tool_call",
              callId: "write-with-stale-digest",
              toolName: WORKSPACE_WRITE_TOOL_REF.name,
              input: {
                path: "src/status.ts",
                content: "export const status = 'safeguarded';\n",
                expectedDigest: `sha256:${"0".repeat(64)}`,
              },
            },
            { type: "text", text: "The controlled write did not apply." },
          ],
        },
        {
          roleRunId: "role-executor-2",
          responses: [
            {
              type: "tool_call",
              callId: "write-approved-output",
              toolName: WORKSPACE_WRITE_TOOL_REF.name,
              input: {
                path: "src/status.ts",
                content: "export const status = 'safeguarded';\n",
                expectedDigest: "absent",
              },
            },
            {
              type: "tool_call",
              callId: "submit-execution-result",
              toolName: SUBMIT_EXECUTION_TOOL_REF.name,
              input: {
                summary: "Added the approved safeguarding status",
                changedPaths: ["src/status.ts"],
                selfChecks: ["Reviewed the controlled tool result"],
              },
            },
            { type: "text", text: "Execution handoff complete." },
          ],
        },
        {
          roleRunId: "role-verifier-1",
          responses: [
            {
              type: "tool_call",
              callId: "submit-verification-result",
              toolName: SUBMIT_VERIFICATION_TOOL_REF.name,
              input: {
                verdict: "pass",
                reason: "The external required check passed for the bound output",
                findings: [],
              },
            },
            { type: "text", text: "Independent verification complete." },
          ],
        },
      ],
    });
    let fixture: HarnessFixture<DeterministicPiRuntimeAdapter> | undefined;
    try {
      fixture = await createHarnessFixture({
        runtime,
        model: DETERMINISTIC_PI_MODEL,
        ...(configuredTarget === undefined ? {} : { targetRoot: configuredTarget }),
        repositoryId: "emi-pilot-ts",
        harnessCommit,
        runtimeAdapter: versionedRuntimeRef(
          "runtime-pi/testing/deterministic-pi-runtime-adapter",
          "0.1.0",
          "pi-agent-session-with-faux-provider",
        ),
        piPackages: [
          versionedRuntimeRef("@earendil-works/pi-agent-core", "0.84.2", "sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA=="),
          versionedRuntimeRef("@earendil-works/pi-ai", "0.84.2", "sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig=="),
          versionedRuntimeRef("@earendil-works/pi-coding-agent", "0.84.2", "sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA=="),
        ],
        runtimeEnvironment: versionedRuntimeRef("node-pnpm", `${process.version}/pnpm@11.7.0`, "local-calibration"),
        prepareTarget: async (root) => {
          await Promise.all([
            writeFile(join(root, "package.json"), JSON.stringify({
              name: "emi-pilot-ts-fixture",
              version: "0.1.0",
              private: true,
              type: "module",
            }, null, 2) + "\n", "utf8"),
            writeFile(join(root, "tsconfig.json"), JSON.stringify({
              compilerOptions: {
                target: "ES2024",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                strict: true,
                noEmit: true,
              },
              include: ["src/**/*.ts"],
            }, null, 2) + "\n", "utf8"),
            writeFile(
              join(root, "checks/verify.mjs"),
              "import { readFile } from 'node:fs/promises'; import { stripTypeScriptTypes } from 'node:module'; const source = await readFile(new URL('../src/status.ts', import.meta.url), 'utf8'); const js = stripTypeScriptTypes(source); const loaded = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`); if (loaded.status !== 'safeguarded') process.exit(1); process.stdout.write('typescript status verified\\n');\n",
              "utf8",
            ),
          ]);
          await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
          await execFileAsync("git", ["config", "user.name", "EMI Harness Test"], { cwd: root });
          await execFileAsync("git", ["config", "user.email", "emi-harness-test@example.invalid"], { cwd: root });
          await execFileAsync("git", ["add", "."], { cwd: root });
          await execFileAsync("git", ["commit", "-m", "test: establish TypeScript target baseline"], { cwd: root });
          return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
        },
      });
      expect(fixture.manifest.target.baseCommit).toMatch(/^[0-9a-f]{40}$/u);
      const first = await fixture.coordinator.execute({
        taskId: "task-1",
        runId: "run-1",
        roleRunId: "role-executor-1",
        rolePlanId: "executor-plan",
        cwd: fixture.root,
        prompt: "Apply the approved TypeScript change.",
        worker: executorWorker,
        executionResultId: "execution-result-failed",
      });
      expect(first).toMatchObject({
        status: "failed",
        errorCode: "invalid_execution_submission",
        task: { status: "executing" },
        roleRun: { status: "settled", outcome: "failed", attempt: 1 },
      });

      const execution = await fixture.coordinator.execute({
        taskId: "task-1",
        runId: "run-1",
        roleRunId: "role-executor-2",
        rolePlanId: "executor-plan",
        cwd: fixture.root,
        prompt: "Retry the approved TypeScript change after the known precondition failure.",
        worker: executorWorker,
        executionResultId: "execution-result-1",
      });
      expect(execution.status).toBe("completed");
      if (execution.status !== "completed") throw new Error("Second Executor attempt failed");
      expect(execution.roleRun.attempt).toBe(2);

      const verification = await fixture.coordinator.verify({
        taskId: "task-1",
        runId: "run-1",
        roleRunId: "role-verifier-1",
        rolePlanId: "verifier-plan",
        cwd: fixture.root,
        prompt: "Independently verify the exact Executor handoff.",
        worker: verifierWorker,
        executionResult: execution.executionResult,
        executorRoleRunId: execution.roleRun.roleRunId,
        verificationResultId: "verification-result-1",
      });
      expect(verification.status).toBe("completed");
      if (verification.status !== "completed") throw new Error("Verifier failed");
      expect(verification.task.status).toBe("awaiting_acceptance");
      expect((await execFileAsync("git", ["status", "--short", "--untracked-files=all"], { cwd: fixture.root })).stdout.trim()).toBe(
        "?? src/status.ts",
      );

      const contextRef = fixture.manifest.roles.find((role) => role.role === "executor")!.resources[0]!;
      const controlledContext = await fixture.resourceRegistry.load(contextRef, "executor");
      const candidate = new CandidateEvidencePackageBuilder({
        controlPlane: fixture.controlPlane,
        toolGateway: fixture.gateway,
        evidenceStore: fixture.evidence,
      }).build({
        packageId: "candidate-run-1",
        taskId: "task-1",
        runId: "run-1",
        exportedAt: "2026-08-21T00:00:00.000Z",
        controlledResources: [JSON.parse(JSON.stringify({
          ref: controlledContext.ref,
          manifest: controlledContext.manifest,
          content: controlledContext.content,
        }))],
      });
      expect(candidate.content.acceptance).toEqual({
        status: "pending",
        taskStatus: "awaiting_acceptance",
        userDecisionRecorded: false,
      });
      const serializedCandidate = serializeCandidateEvidencePackage(candidate);
      expect(parseCandidateEvidencePackage(serializedCandidate)).toEqual(candidate);
      expect(() => parseCandidateEvidencePackage(serializedCandidate.replace("pending", "tampered"))).toThrow(
        "digest or acceptance boundary",
      );
      const packagePath = ".emi-harness/evidence/run-1.candidate.json";
      await writeCandidateEvidencePackage({ targetRoot: fixture.root, relativePath: packagePath, envelope: candidate });
      await expect(writeCandidateEvidencePackage({
        targetRoot: fixture.root,
        relativePath: packagePath,
        envelope: candidate,
      })).rejects.toThrow();
      expect(parseCandidateEvidencePackage(await readFile(join(fixture.root, packagePath), "utf8"))).toEqual(candidate);

      const starts = runtime.starts();
      expect(starts.map((start) => start.roleRunId)).toEqual([
        "role-executor-1",
        "role-executor-2",
        "role-verifier-1",
      ]);
      expect(new Set(starts.map((start) => start.sessionId)).size).toBe(3);
      expect(starts[2]?.toolNames).toEqual([SUBMIT_VERIFICATION_TOOL_REF.name]);
      expect(JSON.stringify(starts.map((start) => start.resourceSources))).not.toContain("AGENTS.md");
      expect(runtime.usedScripts()).toEqual(["role-executor-1", "role-executor-2", "role-verifier-1"]);

      const firstOperationId = fixture.controlPlane.getRoleRun("role-executor-1").toolOperationRefs[0];
      expect(firstOperationId).toBeDefined();
      const successfulOperationId = execution.operationIds[0];
      expect(successfulOperationId).toBeDefined();
      fixture.closeStores();

      const clock = new TestClock();
      const reopenedControlPlane = new SqliteControlPlane({
        databasePath: fixture.statePaths.controlPlane,
        clock,
        idGenerator: new TestIds(),
      });
      const reopenedExecutor = await SubprocessWorkspaceExecutor.create({
        repositoryId: "emi-pilot-ts",
        workspaceRoot: fixture.root,
      });
      const reopenedGateway = new SqliteToolGateway({
        databasePath: fixture.statePaths.toolGateway,
        authority: new ControlPlaneRoleRunAuthority(reopenedControlPlane, clock),
        executor: reopenedExecutor,
        registrations: [{ definition: WORKSPACE_WRITE_TOOL, policy: new WorkspaceWritePolicy() }],
        clock,
        idGenerator: new TestIds(),
      });
      const reopenedEvidence = new SqliteEvidenceStore({ databasePath: fixture.statePaths.evidence, clock });
      try {
        expect(reopenedControlPlane.getTask("task-1").status).toBe("awaiting_acceptance");
        expect(reopenedControlPlane.getRun("run-1").status).toBe("active");
        expect(reopenedGateway.getOperation(firstOperationId!)).toMatchObject({ status: "failed" });
        expect(reopenedGateway.getOperation(successfulOperationId!)).toMatchObject({ status: "succeeded" });
        expect(reopenedEvidence.listForRun("run-1").map((record) => record.kind).sort()).toEqual([
          "check_result",
          "execution",
          "runtime",
          "runtime",
          "runtime",
          "tool_operation",
          "tool_operation",
          "verification_assurance",
        ].sort());
        expect(JSON.stringify(reopenedEvidence.listForRun("run-1"))).toContain("tool_execution_start");
        expect(parseCandidateEvidencePackage(await readFile(join(fixture.root, packagePath), "utf8")).digest).toBe(
          candidate.digest,
        );
      } finally {
        reopenedEvidence.close();
        reopenedGateway.close();
        reopenedControlPlane.close();
      }
    } finally {
      runtime.dispose();
      if (fixture !== undefined) await fixture.close();
      await rm(agentRoot, { recursive: true, force: true });
    }
  });
});
