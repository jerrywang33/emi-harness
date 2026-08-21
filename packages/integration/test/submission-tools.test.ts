import { describe, expect, it } from "vitest";

import {
  ExecutionSubmissionCollector,
  INTERNAL_SUBMISSION_POLICY_REF,
  SUBMIT_EXECUTION_TOOL_REF,
  SUBMIT_VERIFICATION_TOOL_REF,
  VERIFIER_READONLY_ISOLATION_REF,
} from "../src/index.js";

describe("internal role submission tools", () => {
  it("pins the v1 definitions and rejects duplicate accepted submissions", async () => {
    expect(INTERNAL_SUBMISSION_POLICY_REF.digest).toBe(
      "sha256:6f18b5c155991649b6001155454c75bbd483f4ce94d7cec44176099e073d6356",
    );
    expect(SUBMIT_EXECUTION_TOOL_REF.definitionDigest).toBe(
      "sha256:1f64ecee0992484ef3684bb9af6c38dd3284dcc313d44db2e210e64694eee435",
    );
    expect(SUBMIT_VERIFICATION_TOOL_REF.definitionDigest).toBe(
      "sha256:b8658fefcc8f1abc7e9ff2ce8a245de483181645f9fcb2c052f1dee32c926b7d",
    );
    expect(VERIFIER_READONLY_ISOLATION_REF.digest).toBe(
      "sha256:f738c54ab11e3e300dd8c887a389750a210d1b73b3b108915a76c408a611a34c",
    );
    const collector = new ExecutionSubmissionCollector();
    const input = { summary: "implemented", changedPaths: ["src/status.ts"], selfChecks: [] };
    await expect(collector.tool.execute({ callId: "one", input, signal: undefined })).resolves.toMatchObject({
      details: { accepted: true },
    });
    await expect(collector.tool.execute({ callId: "two", input, signal: undefined })).resolves.toMatchObject({ isError: true });
    expect(() => collector.requireSingle()).toThrow("more than once");
  });
});
