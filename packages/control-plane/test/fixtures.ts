import type {
  Actor,
  ArtifactInput,
  Clock,
  IdGenerator,
  RunManifestV1,
  SqliteControlPlane,
  VersionedRef,
} from "../src/index.js";
import { digestJson } from "../src/index.js";

export class TestClock implements Clock {
  constructor(private value = "2026-08-21T00:00:00.000Z") {}

  now(): string {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value = new Date(Date.parse(this.value) + milliseconds).toISOString();
  }
}

export class TestIds implements IdGenerator {
  private value = 0;

  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${String(this.value).padStart(4, "0")}`;
  }
}

export const coordinator: Actor = { actorId: "agent-coordinator", actorType: "agent", roles: ["coordinator"] };
export const architect: Actor = { actorId: "human-architect", actorType: "human", roles: ["architecture_authority"] };
export const deliveryAuthority: Actor = {
  actorId: "human-delivery",
  actorType: "human",
  roles: ["delivery_authority"],
};
export const executorWorker: Actor = { actorId: "worker-executor", actorType: "worker", roles: ["executor_worker"] };
export const verifierWorker: Actor = { actorId: "worker-verifier", actorType: "worker", roles: ["verifier_worker"] };

export function artifact(id: string, kind: string, content: ArtifactInput["content"], createdBy = "test-author"): ArtifactInput {
  return { id, version: "1", kind, content, digest: digestJson(content), createdBy };
}

export function ref(value: ArtifactInput): VersionedRef {
  return { id: value.id, version: value.version, digest: value.digest };
}

export interface Prerequisites {
  prd: ArtifactInput;
  context: ArtifactInput;
  trd: ArtifactInput;
  executionPlan: ArtifactInput;
  acceptanceCriteria: ArtifactInput;
  check: ArtifactInput;
}

export function registerPrerequisites(controlPlane: SqliteControlPlane): Prerequisites {
  const values: Prerequisites = {
    prd: artifact("prd-1", "prd", { goal: "Add safeguarded account status", scope: ["src/account.ts"] }),
    context: artifact("context-1", "context_manifest", {
      jurisdiction: "EEA",
      controls: [{ id: "safeguarding-status", status: "confirmed" }],
    }),
    trd: artifact("trd-1", "trd", { behavior: "Expose safeguarded status", acceptance: ["check-1"] }),
    executionPlan: artifact("plan-1", "execution_plan", { steps: ["edit", "test", "verify"] }),
    acceptanceCriteria: artifact("criteria-1", "acceptance_criteria", { criteria: ["status is immutable"] }),
    check: artifact("check-1", "check_definition", { command: "pnpm test", expectedExitCode: 0 }),
  };
  let number = 0;
  for (const value of Object.values(values)) {
    number += 1;
    controlPlane.registerArtifact({ commandId: `artifact-${number}`, actor: coordinator, artifact: value });
  }
  return values;
}

export function manifest(
  taskRevision: number,
  prerequisites: Prerequisites,
  trdApproval: VersionedRef,
  roleOrder: "normal" | "reversed" = "normal",
): RunManifestV1 {
  const constantRef = (id: string): VersionedRef => ({ id, version: "1", digest: digestJson({ id }) });
  const rolePlans: RunManifestV1["roles"] = [
    {
      rolePlanId: "executor-plan",
      role: "executor",
      model: { provider: "test", modelId: "deterministic" },
      resources: [constantRef("resource-1")],
      skills: [constantRef("skill-execute")],
      prompts: [constantRef("prompt-executor")],
      tools: [
        {
          name: "workspace.patch",
          version: "1",
          definitionDigest: digestJson({ name: "workspace.patch", version: "1" }),
          policyRef: constantRef("policy-tool"),
        },
      ],
      isolationProfile: constantRef("isolation-local"),
      credentialBindings: [],
      limits: { maxAttempts: 2, timeoutMs: 60_000 },
    },
    {
      rolePlanId: "verifier-plan",
      role: "verifier",
      model: { provider: "test", modelId: "deterministic" },
      resources: [constantRef("resource-1")],
      skills: [constantRef("skill-verify")],
      prompts: [constantRef("prompt-verifier")],
      tools: [],
      isolationProfile: constantRef("isolation-local-readonly"),
      credentialBindings: [],
      limits: { maxAttempts: 2, timeoutMs: 60_000 },
    },
  ];
  return {
    schemaVersion: "1",
    runId: "run-1",
    composedAt: "2026-08-21T00:00:00.000Z",
    composedBy: coordinator.actorId,
    task: { taskId: "task-1", taskRevision },
    inputs: {
      prd: ref(prerequisites.prd),
      contextManifest: ref(prerequisites.context),
      trd: ref(prerequisites.trd),
      executionPlan: ref(prerequisites.executionPlan),
      prerequisiteApprovals: [trdApproval],
    },
    target: {
      repositoryId: "local-target",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      allowedPaths: ["test/account.test.ts", "src/account.ts"],
    },
    runtime: {
      harnessCommit: "fedcba9876543210fedcba9876543210fedcba98",
      adapter: constantRef("runtime-pi-adapter"),
      piPackages: [constantRef("pi-coding-agent"), constantRef("pi-agent-core")],
      environment: constantRef("node-24"),
    },
    roles: roleOrder === "normal" ? rolePlans : [...rolePlans].reverse(),
    policies: {
      policyRefs: [constantRef("policy-control-plane")],
      approvalConditions: [],
      maxRoleRuns: 4,
      maxDurationMs: 300_000,
    },
    verification: {
      acceptanceCriteria: ref(prerequisites.acceptanceCriteria),
      requiredChecks: [ref(prerequisites.check)],
      requiredEvidence: ["test-report"],
    },
  };
}

export function advanceToPlanning(controlPlane: SqliteControlPlane, prerequisites: Prerequisites): VersionedRef {
  controlPlane.createTask({
    commandId: "create-task",
    actor: coordinator,
    taskId: "task-1",
    goal: "Implement safeguarded account status",
    prd: ref(prerequisites.prd),
  });
  controlPlane.startContextualization({
    commandId: "start-context",
    actor: coordinator,
    taskId: "task-1",
    expectedTaskVersion: 1,
    reason: "PRD is complete",
  });
  controlPlane.completeContextualization({
    commandId: "complete-context",
    actor: coordinator,
    taskId: "task-1",
    expectedTaskVersion: 2,
    contextManifest: ref(prerequisites.context),
    evidenceRefs: ["context-review"],
  });
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
  controlPlane.recordApprovalDecision({
    commandId: "approve-trd",
    actor: architect,
    approvalId: "approval-trd-1",
    expectedApprovalVersion: 1,
    expectedTaskVersion: 4,
    decisionId: "decision-trd-1",
    authorityRole: "architecture_authority",
    decision: "approved",
    reason: "Design meets the accepted control",
    conditions: [],
    evidenceRefs: ["architecture-review"],
  });
  return controlPlane.getApprovalRef("approval-trd-1");
}

export function authorizeRun(
  controlPlane: SqliteControlPlane,
  prerequisites: Prerequisites,
): { manifest: RunManifestV1; manifestDigest: string } {
  const trdApproval = advanceToPlanning(controlPlane, prerequisites);
  const runManifest = manifest(5, prerequisites, trdApproval);
  const sealed = controlPlane.sealRunManifest({
    commandId: "seal-run",
    actor: coordinator,
    taskId: "task-1",
    expectedTaskVersion: 5,
    runId: "run-1",
    manifest: runManifest,
    authorizationApprovalId: "approval-run-1",
    authorizationPolicyVersion: "run-policy-1",
    requiredAuthorizationRoles: ["delivery_authority"],
  });
  controlPlane.recordApprovalDecision({
    commandId: "approve-run",
    actor: deliveryAuthority,
    approvalId: "approval-run-1",
    expectedApprovalVersion: 1,
    expectedTaskVersion: 5,
    expectedRunVersion: 1,
    decisionId: "decision-run-1",
    authorityRole: "delivery_authority",
    decision: "approved",
    reason: "Scope and tool permissions are acceptable",
    conditions: [],
    evidenceRefs: ["run-review"],
  });
  return { manifest: runManifest, manifestDigest: sealed.manifestDigest };
}
