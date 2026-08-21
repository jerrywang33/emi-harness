import { digestJson } from "./canonical-json.js";
import type { JsonObject, ToolDefinitionV1, VersionedRef } from "./types.js";

const workspaceWriteInputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["path", "content", "expectedDigest"],
  properties: {
    path: { type: "string", minLength: 1 },
    content: { type: "string", maxLength: 131_072 },
    expectedDigest: {
      oneOf: [
        { const: "absent" },
        { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      ],
    },
  },
};

const workspaceWriteDefinitionDocument = {
  name: "workspace.write_text",
  version: "1",
  description: "Create or atomically replace one approved UTF-8 text file using a required previous-content digest.",
  inputSchema: workspaceWriteInputSchema,
};

export const WORKSPACE_WRITE_TOOL: ToolDefinitionV1 = Object.freeze({
  ...workspaceWriteDefinitionDocument,
  definitionDigest: digestJson(workspaceWriteDefinitionDocument),
});

const workspaceWritePolicyDocument = {
  id: "emi.policy.workspace-write",
  version: "1",
  role: "executor",
  allowedPathMode: "exact_manifest_entry",
  maxUtf8Bytes: 128 * 1024,
  compareAndSetRequired: true,
};

export const WORKSPACE_WRITE_POLICY_REF: VersionedRef = Object.freeze({
  id: workspaceWritePolicyDocument.id,
  version: workspaceWritePolicyDocument.version,
  digest: digestJson(workspaceWritePolicyDocument),
});

const localSubprocessIsolationDocument = {
  id: "emi.isolation.local-workspace-subprocess",
  version: "1",
  processBoundary: true,
  exposedOperations: ["workspace.write_text"],
  shell: false,
  networkGuarantee: "not_provided_v0.1",
};

export const LOCAL_WORKSPACE_ISOLATION_REF: VersionedRef = Object.freeze({
  id: localSubprocessIsolationDocument.id,
  version: localSubprocessIsolationDocument.version,
  digest: digestJson(localSubprocessIsolationDocument),
});

export const WORKSPACE_WRITE_TOOL_REF = Object.freeze({
  name: WORKSPACE_WRITE_TOOL.name,
  version: WORKSPACE_WRITE_TOOL.version,
  definitionDigest: WORKSPACE_WRITE_TOOL.definitionDigest,
  policyRef: WORKSPACE_WRITE_POLICY_REF,
});
