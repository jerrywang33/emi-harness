import { describe, expect, it } from "vitest";

import { digestJson, normalizeRunManifest } from "../src/index.js";
import { artifact, manifest } from "./fixtures.js";

describe("RunManifest normalization", () => {
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
