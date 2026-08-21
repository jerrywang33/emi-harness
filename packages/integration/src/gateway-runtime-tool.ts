import type { JsonObject, RuntimeTool } from "@emi-harness/runtime-pi";
import {
  WORKSPACE_WRITE_TOOL,
  WORKSPACE_WRITE_TOOL_REF,
  type SqliteToolGateway,
  type ToolPlanRef,
} from "@emi-harness/tool-gateway";

import { assertToolRef } from "./submission-tools.js";

export interface GatewayRuntimeContext {
  runId: string;
  roleRunId: string;
  leaseToken: number;
}

export class GatewayRuntimeToolCollector {
  private readonly ids = new Set<string>();

  constructor(private readonly gateway: SqliteToolGateway) {}

  createWorkspaceWriteTool(plan: ToolPlanRef, context: GatewayRuntimeContext): RuntimeTool {
    assertToolRef(plan, WORKSPACE_WRITE_TOOL_REF);
    return {
      name: WORKSPACE_WRITE_TOOL.name,
      description: WORKSPACE_WRITE_TOOL.description,
      inputSchema: WORKSPACE_WRITE_TOOL.inputSchema as JsonObject,
      execute: async ({ callId, input, signal }) => {
        const outcome = await this.gateway.invoke(
          {
            runId: context.runId,
            roleRunId: context.roleRunId,
            leaseToken: context.leaseToken,
            callId,
            tool: plan,
            input,
          },
          signal,
        );
        this.ids.add(outcome.operation.operationId);
        const resultDigest = outcome.result?.outputDigest;
        return {
          text: JSON.stringify({
            operationId: outcome.operation.operationId,
            status: outcome.operation.status,
            ...(resultDigest === undefined ? {} : { resultDigest }),
          }),
          isError: outcome.operation.status !== "succeeded",
          details: {
            operationId: outcome.operation.operationId,
            status: outcome.operation.status,
            ...(resultDigest === undefined ? {} : { resultDigest }),
          },
        };
      },
    };
  }

  operationIds(): string[] {
    return [...this.ids].sort();
  }
}
