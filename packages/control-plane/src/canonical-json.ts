import { createHash } from "node:crypto";

import type { RunManifestV1, VersionedRef } from "./types.js";

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function assertValidString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= LOW_SURROGATE_START && next <= LOW_SURROGATE_END)) {
        throw new TypeError("Canonical JSON rejects unpaired UTF-16 high surrogates");
      }
      index += 1;
    } else if (code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END) {
      throw new TypeError("Canonical JSON rejects unpaired UTF-16 low surrogates");
    }
  }
}

function serialize(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON only accepts finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertValidString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON only accepts plain objects");
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, item]) => {
        if (item === undefined) {
          throw new TypeError(`Canonical JSON rejects undefined property: ${key}`);
        }
        assertValidString(key);
        return `${JSON.stringify(key)}:${serialize(item)}`;
      })
      .join(",")}}`;
  }
  throw new TypeError(`Canonical JSON rejects value of type ${typeof value}`);
}

export function canonicalizeJson(value: unknown): string {
  return serialize(value);
}

export function sha256Digest(canonicalJson: string): string {
  return `sha256:${createHash("sha256").update(canonicalJson, "utf8").digest("hex")}`;
}

export function digestJson(value: unknown): string {
  return sha256Digest(canonicalizeJson(value));
}

function sortRefs(refs: readonly VersionedRef[]): VersionedRef[] {
  return [...refs].sort((left, right) => compareText(
    `${left.id}\u0000${left.version}\u0000${left.digest}`,
    `${right.id}\u0000${right.version}\u0000${right.digest}`,
  ));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
