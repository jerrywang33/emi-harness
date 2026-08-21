import { describe, expect, it } from "vitest";

import { canonicalizeJson, digestJson, normalizeRunManifest } from "../src/index.js";
import { artifact, manifest } from "./fixtures.js";

describe("canonical JSON", () => {
  it("uses deterministic RFC 8785 property ordering and ECMAScript number encoding", () => {
    expect(canonicalizeJson({ string: "€$\u000f\nA'B\"\\\"/", numbers: [333333333.3333333, 1e30, 4.5, 0.002, 1e-27] })).toBe(
      "{\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
    );
  });

  it("rejects values that JSON would silently coerce", () => {
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrow("finite numbers");
    expect(() => canonicalizeJson({ value: undefined })).toThrow("undefined property");
    expect(() => canonicalizeJson({ value: "\ud800" })).toThrow("unpaired");
  });

  it("normalizes manifest sets before hashing", () => {
    const fake = {
      prd: artifact("prd", "prd", {}),
      context: artifact("context", "context_manifest", {}),
      trd: artifact("trd", "trd", {}),
      executionPlan: artifact("plan", "execution_plan", {}),
      acceptanceCriteria: artifact("criteria", "acceptance_criteria", {}),
      check: artifact("check", "check_definition", {}),
    };
    const approval = { id: "approval", version: "2", digest: "sha256:g" };
    const normal = manifest(5, fake, approval, "normal");
    const reversed = manifest(5, fake, approval, "reversed");
    reversed.target.allowedPaths = [...reversed.target.allowedPaths].reverse();
    expect(digestJson(normalizeRunManifest(normal))).toBe(digestJson(normalizeRunManifest(reversed)));
  });
});
