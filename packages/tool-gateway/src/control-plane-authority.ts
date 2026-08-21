import { fail } from "./errors.js";
import type {
  Clock,
  RoleRunAuthorityPort,
  RoleRunAuthoritySnapshot,
  ToolInvocationRequest,
  ToolPlanRef,
  VersionedRef,
} from "./types.js";

interface AuthorityRolePlan {
  rolePlanId: string;
  role: "coordinator" | "executor" | "verifier";
  tools: readonly ToolPlanRef[];
  isolationProfile: VersionedRef;
}

export interface ControlPlaneAuthorityReader {
  getRun(runId: string): { runId: string; status: string };
  getRoleRun(roleRunId: string): {
    roleRunId: string;
    runId: string;
    rolePlanId: string;
    role: "coordinator" | "executor" | "verifier";
    status: string;
    leaseToken: number;
    leaseExpiresAt?: string;
  };
  getRunManifest(runId: string): {
    manifest: {
      target: { repositoryId: string; baseCommit: string; allowedPaths: readonly string[] };
      roles: readonly AuthorityRolePlan[];
    };
  };
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}

function sameTool(left: ToolPlanRef, right: ToolPlanRef): boolean {
  return (
    left.name === right.name &&
    left.version === right.version &&
    left.definitionDigest === right.definitionDigest &&
    sameRef(left.policyRef, right.policyRef)
  );
}

export class ControlPlaneRoleRunAuthority implements RoleRunAuthorityPort {
  constructor(
    private readonly reader: ControlPlaneAuthorityReader,
    private readonly clock: Clock = { now: () => new Date().toISOString() },
  ) {}

  async authorize(request: ToolInvocationRequest): Promise<RoleRunAuthoritySnapshot> {
    const run = this.reader.getRun(request.runId);
    const roleRun = this.reader.getRoleRun(request.roleRunId);
    if (run.runId !== request.runId || run.status !== "active") {
      fail("authorization_denied", `Run is not active: ${request.runId}`);
    }
    if (roleRun.runId !== run.runId || roleRun.status !== "running") {
      fail("authorization_denied", `RoleRun is not running in Run: ${request.roleRunId}`);
    }
    if (roleRun.role !== "executor") {
      fail("authorization_denied", `RoleRun cannot request side effects: ${request.roleRunId}`);
    }
    if (request.leaseToken <= 0 || roleRun.leaseToken !== request.leaseToken) {
      fail("authorization_denied", `Stale fencing token for RoleRun: ${request.roleRunId}`);
    }
    if (roleRun.leaseExpiresAt === undefined || roleRun.leaseExpiresAt <= this.clock.now()) {
      fail("authorization_denied", `RoleRun lease has expired: ${request.roleRunId}`);
    }
    const manifest = this.reader.getRunManifest(run.runId).manifest;
    const rolePlan = manifest.roles.find((candidate) => candidate.rolePlanId === roleRun.rolePlanId);
    if (rolePlan === undefined || rolePlan.role !== roleRun.role) {
      fail("authorization_denied", `RolePlan does not match RoleRun: ${request.roleRunId}`);
    }
    const plannedTool = rolePlan.tools.find(
      (candidate) => candidate.name === request.tool.name && candidate.version === request.tool.version,
    );
    if (plannedTool === undefined || !sameTool(plannedTool, request.tool)) {
      fail("authorization_denied", `Tool is not exactly authorized by RolePlan: ${request.tool.name}`);
    }
    return {
      runId: run.runId,
      roleRunId: roleRun.roleRunId,
      rolePlanId: roleRun.rolePlanId,
      role: roleRun.role,
      leaseToken: roleRun.leaseToken,
      leaseExpiresAt: roleRun.leaseExpiresAt,
      repositoryId: manifest.target.repositoryId,
      baseCommit: manifest.target.baseCommit,
      allowedPaths: [...manifest.target.allowedPaths],
      tool: plannedTool,
      isolationProfile: rolePlan.isolationProfile,
    };
  }
}
