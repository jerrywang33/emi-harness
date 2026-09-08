import type {
  Clock,
  ControlPlaneAuthorityReader,
  IdGenerator,
  IsolatedToolExecutorPort,
  RoleRunAuthorityPort,
  ToolInvocationRequest,
  ToolPolicyPort,
} from "../src/index.js";
import {
  ControlPlaneRoleRunAuthority,
  LOCAL_WORKSPACE_ISOLATION_REF,
  SqliteToolGateway,
  SubprocessWorkspaceExecutor,
  WORKSPACE_WRITE_TOOL,
  WORKSPACE_WRITE_TOOL_REF,
  WorkspaceWritePolicy,
} from "../src/index.js";

export class TestClock implements Clock {
  constructor(private value = "2026-08-21T00:00:00.000Z") {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

export class TestIds implements IdGenerator {
  private value = 0;

  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${String(this.value).padStart(4, "0")}`;
  }
}

export interface MutableAuthorityState {
  approvalSupported: boolean;
  runStatus: string;
  role: "coordinator" | "executor" | "verifier";
  roleRunStatus: string;
  leaseToken: number;
  leaseExpiresAt: string;
  allowedPaths: string[];
}

export function authorityFixture(state: MutableAuthorityState): ControlPlaneAuthorityReader {
  return {
    assertRunAuthorization: () => {
      if (!state.approvalSupported) throw new Error("Historical conditional approval is unsupported");
    },
    getRun: (runId) => ({ runId, status: state.runStatus }),
    getRoleRun: (roleRunId) => ({
      roleRunId,
      runId: "run-1",
      rolePlanId: "executor-plan",
      role: state.role,
      status: state.roleRunStatus,
      leaseToken: state.leaseToken,
      leaseExpiresAt: state.leaseExpiresAt,
    }),
    getRunManifest: () => ({
      manifest: {
        target: {
          repositoryId: "local-target",
          baseCommit: "0123456789abcdef0123456789abcdef01234567",
          allowedPaths: state.allowedPaths,
        },
        roles: [
          {
            rolePlanId: "executor-plan",
            role: state.role,
            tools: [WORKSPACE_WRITE_TOOL_REF],
            isolationProfile: LOCAL_WORKSPACE_ISOLATION_REF,
          },
        ],
      },
    }),
  };
}

export function authorizedState(): MutableAuthorityState {
  return {
    approvalSupported: true,
    runStatus: "active",
    role: "executor",
    roleRunStatus: "running",
    leaseToken: 7,
    leaseExpiresAt: "2026-08-21T01:00:00.000Z",
    allowedPaths: ["src/value.ts"],
  };
}

export function request(overrides: Partial<ToolInvocationRequest> = {}): ToolInvocationRequest {
  return {
    runId: "run-1",
    roleRunId: "role-executor-1",
    leaseToken: 7,
    callId: "tool-call-1",
    tool: WORKSPACE_WRITE_TOOL_REF,
    input: { path: "src/value.ts", content: "export const value = 1;\n", expectedDigest: "absent" },
    ...overrides,
  };
}

export async function gatewayFixture(input: {
  databasePath: string;
  workspaceRoot: string;
  state?: MutableAuthorityState;
  clock?: TestClock;
  ids?: TestIds;
  executor?: IsolatedToolExecutorPort;
  authority?: RoleRunAuthorityPort;
  policy?: ToolPolicyPort;
}): Promise<{ gateway: SqliteToolGateway; executor: IsolatedToolExecutorPort; state: MutableAuthorityState; clock: TestClock }> {
  const state = input.state ?? authorizedState();
  const clock = input.clock ?? new TestClock();
  const executor = input.executor ?? (await SubprocessWorkspaceExecutor.create({
    repositoryId: "local-target",
    workspaceRoot: input.workspaceRoot,
  }));
  return {
    gateway: new SqliteToolGateway({
      databasePath: input.databasePath,
      authority: input.authority ?? new ControlPlaneRoleRunAuthority(authorityFixture(state), clock),
      executor,
      registrations: [{ definition: WORKSPACE_WRITE_TOOL, policy: input.policy ?? new WorkspaceWritePolicy() }],
      clock,
      idGenerator: input.ids ?? new TestIds(),
    }),
    executor,
    state,
    clock,
  };
}
