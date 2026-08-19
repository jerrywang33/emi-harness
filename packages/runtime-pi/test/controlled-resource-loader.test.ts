import { describe, expect, it } from "vitest";

import { ControlledResourceLoader } from "../src/controlled-resource-loader.js";

describe("ControlledResourceLoader", () => {
  it("returns only the resources supplied by the run manifest", async () => {
    const loader = new ControlledResourceLoader({
      systemPrompt: { source: "emi://prompt/system", content: "controlled system" },
      appendSystemPrompts: [{ source: "emi://prompt/policy", content: "controlled policy" }],
      contextFiles: [{ source: "emi://context/approved", content: "approved context" }],
    });

    await loader.reload();

    expect(loader.getSystemPrompt()).toBe("controlled system");
    expect(loader.getSystemPromptSource()).toEqual({ path: "emi://prompt/system" });
    expect(loader.getAppendSystemPrompt()).toEqual(["controlled policy"]);
    expect(loader.getAppendSystemPromptSources()).toEqual([{ path: "emi://prompt/policy" }]);
    expect(loader.getAgentsFiles()).toEqual({
      agentsFiles: [{ path: "emi://context/approved", content: "approved context" }],
    });
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
  });

  it("rejects runtime resource extension", () => {
    const loader = new ControlledResourceLoader({});

    expect(() => loader.extendResources({})).toThrow("immutable");
  });

  it("rejects resources without a source identity", () => {
    expect(
      () => new ControlledResourceLoader({ systemPrompt: { source: " ", content: "untraceable" } }),
    ).toThrow("source must not be empty");
  });
});
