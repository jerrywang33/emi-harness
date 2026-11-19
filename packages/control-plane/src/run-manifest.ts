import { compareRefs, compareText } from "@emi-harness/canonical-json";

import type { RunManifestV1, VersionedRef } from "./types.js";

function sortRefs(refs: readonly VersionedRef[]): VersionedRef[] {
  return [...refs].sort(compareRefs);
}

export function normalizeRunManifest(manifest: RunManifestV1): RunManifestV1 {
  return {
    ...manifest,
    inputs: {
      ...manifest.inputs,
      prerequisiteApprovals: sortRefs(manifest.inputs.prerequisiteApprovals),
    },
    target: {
      ...manifest.target,
      allowedPaths: [...manifest.target.allowedPaths].sort(),
    },
    runtime: {
      ...manifest.runtime,
      piPackages: sortRefs(manifest.runtime.piPackages),
    },
    roles: [...manifest.roles]
      .sort((left, right) => compareText(left.rolePlanId, right.rolePlanId))
      .map((role) => ({
        ...role,
        resources: sortRefs(role.resources),
        skills: sortRefs(role.skills),
        prompts: sortRefs(role.prompts),
        tools: [...role.tools].sort((left, right) => compareText(
          `${left.name}\u0000${left.version}`,
          `${right.name}\u0000${right.version}`,
        )),
        credentialBindings: [...role.credentialBindings]
          .sort((left, right) => compareText(left.bindingId, right.bindingId))
          .map((binding) => ({ ...binding, scopes: [...binding.scopes].sort() })),
      })),
    policies: {
      ...manifest.policies,
      policyRefs: sortRefs(manifest.policies.policyRefs),
      approvalConditions: [...manifest.policies.approvalConditions]
        .sort((left, right) => compareText(left.conditionId, right.conditionId))
        .map((condition) => ({ ...condition, evidenceRefs: [...condition.evidenceRefs].sort() })),
    },
    verification: {
      ...manifest.verification,
      requiredChecks: sortRefs(manifest.verification.requiredChecks),
      requiredEvidence: [...manifest.verification.requiredEvidence].sort(),
    },
  };
}
