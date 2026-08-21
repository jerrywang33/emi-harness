import { digestJson } from "@emi-harness/control-plane";
import type { JsonObject, RuntimeTool } from "@emi-harness/runtime-pi";
import type { ToolPlanRef, VersionedRef } from "@emi-harness/tool-gateway";

import { fail } from "./errors.js";
import type { ExecutionSubmission, VerificationSubmission } from "./types.js";

const internalSubmissionPolicyDocument = {
  id: "emi.policy.internal-role-submission",
  version: "1",
  sideEffect: false,
  persistenceAuthority: "integration_collector",
  maxAcceptedSubmissions: 1,
};

export const INTERNAL_SUBMISSION_POLICY_REF: VersionedRef = Object.freeze({
  id: internalSubmissionPolicyDocument.id,
  version: internalSubmissionPolicyDocument.version,
  digest: digestJson(internalSubmissionPolicyDocument),
});

const verifierReadonlyIsolationDocument = {
  id: "emi.isolation.verifier-runtime-readonly",
  version: "1",
  builtinTools: false,
  sideEffectTools: false,
  controlledResourcesOnly: true,
};

export const VERIFIER_READONLY_ISOLATION_REF: VersionedRef = Object.freeze({
  id: verifierReadonlyIsolationDocument.id,
  version: verifierReadonlyIsolationDocument.version,
  digest: digestJson(verifierReadonlyIsolationDocument),
});

const executionDefinitionDocument = {
  name: "harness.submit_execution",
  version: "1",
  description: "Submit one structured Executor handoff; this does not approve or verify the implementation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "changedPaths", "selfChecks"],
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 4000 },
      changedPaths: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
      selfChecks: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
    },
  },
};

const verificationDefinitionDocument = {
  name: "harness.submit_verification",
  version: "1",
  description: "Submit one independent Verifier assessment bound to externally supplied check observations.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason", "findings"],
    properties: {
      verdict: { enum: ["pass", "fail", "blocked"] },
      findingClass: { enum: ["implementation", "trd", "context", "prd", "external"] },
      reason: { type: "string", minLength: 1, maxLength: 4000 },
      findings: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
    },
  },
};

export const SUBMIT_EXECUTION_TOOL_REF: ToolPlanRef = Object.freeze({
  name: executionDefinitionDocument.name,
  version: executionDefinitionDocument.version,
  definitionDigest: digestJson(executionDefinitionDocument),
  policyRef: INTERNAL_SUBMISSION_POLICY_REF,
});

export const SUBMIT_VERIFICATION_TOOL_REF: ToolPlanRef = Object.freeze({
  name: verificationDefinitionDocument.name,
  version: verificationDefinitionDocument.version,
  definitionDigest: digestJson(verificationDefinitionDocument),
  policyRef: INTERNAL_SUBMISSION_POLICY_REF,
});

function exactKeys(input: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(input);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function uniqueStrings(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    return undefined;
  }
  const strings = value as string[];
  return new Set(strings).size === strings.length ? [...strings] : undefined;
}

function normalizedPath(path: string): boolean {
  return (
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

abstract class SingleSubmissionCollector<T> {
  private submission: T | undefined;
  private duplicate = false;

  protected accept(value: T): { text: string; isError?: boolean; details: JsonObject } {
    if (this.submission !== undefined) {
      this.duplicate = true;
      return { text: "A role submission was already accepted", isError: true, details: { accepted: false } };
    }
    this.submission = value;
    return { text: "Structured role submission accepted", details: { accepted: true } };
  }

  requireSingle(): T {
    if (this.submission === undefined || this.duplicate) {
      fail("invalid_submission", this.duplicate ? "Role submitted more than once" : "Role did not submit a structured result");
    }
    return this.submission;
  }
}

export class ExecutionSubmissionCollector extends SingleSubmissionCollector<ExecutionSubmission> {
  readonly tool: RuntimeTool = {
    name: executionDefinitionDocument.name,
    description: executionDefinitionDocument.description,
    inputSchema: executionDefinitionDocument.inputSchema as JsonObject,
    execute: async ({ input }) => {
      const summary = input.summary;
      const changedPaths = uniqueStrings(input.changedPaths, 50);
      const selfChecks = uniqueStrings(input.selfChecks, 50);
      if (
        !exactKeys(input, ["summary", "changedPaths", "selfChecks"]) ||
        typeof summary !== "string" ||
        summary.trim().length === 0 ||
        summary.length > 4000 ||
        changedPaths === undefined ||
        changedPaths.some((path) => !normalizedPath(path)) ||
        selfChecks === undefined
      ) {
        return { text: "Execution submission input is invalid", isError: true, details: { accepted: false } };
      }
      return this.accept({ summary, changedPaths, selfChecks });
    },
  };
}

export class VerificationSubmissionCollector extends SingleSubmissionCollector<VerificationSubmission> {
  readonly tool: RuntimeTool = {
    name: verificationDefinitionDocument.name,
    description: verificationDefinitionDocument.description,
    inputSchema: verificationDefinitionDocument.inputSchema as JsonObject,
    execute: async ({ input }) => {
      const verdict = input.verdict;
      const findingClass = input.findingClass;
      const reason = input.reason;
      const findings = uniqueStrings(input.findings, 50);
      if (
        !exactKeys(input, ["verdict", "reason", "findings"], ["findingClass"]) ||
        !["pass", "fail", "blocked"].includes(typeof verdict === "string" ? verdict : "") ||
        (findingClass !== undefined && !["implementation", "trd", "context", "prd", "external"].includes(
          typeof findingClass === "string" ? findingClass : "",
        )) ||
        typeof reason !== "string" ||
        reason.trim().length === 0 ||
        reason.length > 4000 ||
        findings === undefined
      ) {
        return { text: "Verification submission input is invalid", isError: true, details: { accepted: false } };
      }
      return this.accept({
        verdict: verdict as VerificationSubmission["verdict"],
        ...(findingClass === undefined ? {} : { findingClass: findingClass as NonNullable<VerificationSubmission["findingClass"]> }),
        reason,
        findings,
      });
    },
  };
}

export function assertToolRef(actual: ToolPlanRef, expected: ToolPlanRef): void {
  if (
    actual.name !== expected.name ||
    actual.version !== expected.version ||
    actual.definitionDigest !== expected.definitionDigest ||
    actual.policyRef.id !== expected.policyRef.id ||
    actual.policyRef.version !== expected.policyRef.version ||
    actual.policyRef.digest !== expected.policyRef.digest
  ) {
    fail("tool_contract_mismatch", `RolePlan tool contract mismatch: ${actual.name}@${actual.version}`);
  }
}
