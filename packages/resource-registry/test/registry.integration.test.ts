import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FileResourceRegistry, ResourceRegistryError } from "../src/index.js";

const resourcesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../resources");

describe("FileResourceRegistry", () => {
  it("loads the pinned safeguarding Context and control-to-TRD Skill", async () => {
    const registry = await FileResourceRegistry.openBundled();
    expect(registry.listRefs()).toEqual([
      {
        id: "emi.safeguarding.payment-funds",
        version: "2026.08.21",
        digest: "sha256:85cefa47f6b0183d6856fa7f8d5f42050eeea8c37081524a03e0b5ec33aed868",
      },
      {
        id: "emi.skill.control-to-trd",
        version: "2026.08.21",
        digest: "sha256:1cc10acb922327972a68e091acd4149b12da24b9f6a4b64f37cde63a281cef27",
      },
    ]);
    const contextRef = registry.resolveRef("emi.safeguarding.payment-funds", "2026.08.21");
    const skillRef = registry.resolveRef("emi.skill.control-to-trd", "2026.08.21");
    const context = await registry.load(contextRef, "coordinator");
    expect(context.manifest).toMatchObject({
      kind: "emi_context",
      status: "active",
      governance: { confirmationStatus: "source_baseline_task_confirmation_required" },
      applicability: { taskConfirmationRequired: true },
    });
    if (context.manifest.kind !== "emi_context") {
      throw new Error("Expected EMI Context");
    }
    expect(context.manifest.sources.map((source) => source.documentId)).toEqual([
      "CELEX:02009L0110-20180113",
      "CELEX:02015L2366-20250117",
      "CELEX:02015L2366-20250117",
    ]);
    expect(context.manifest.statements.map((statement) => statement.statementId)).toEqual([
      "SG-001",
      "SG-002",
      "SG-003",
      "SG-004",
      "TC-001",
      "TC-002",
      "TC-003",
      "TC-004",
      "TC-005",
      "ED-001",
      "ED-002",
      "ED-003",
      "ED-004",
      "ED-005",
    ]);
    expect(context.manifest.statements.some((statement) => statement.classification === "engineering_derived")).toBe(true);
    expect(context.content).toContain("Task Confirmations");
    expect(context.source).toBe("emi-resource:emi.safeguarding.payment-funds@2026.08.21");

    const projection = await registry.project([contextRef, skillRef], "coordinator");
    expect(projection.contextFiles).toHaveLength(1);
    expect(projection.appendSystemPrompts).toHaveLength(1);
    expect(projection.appendSystemPrompts[0]?.content).toContain("Prohibited Actions");
    expect(JSON.stringify(projection)).not.toContain(resourcesRoot);
  });

  it("enforces Skill roles and rejects duplicate Run references", async () => {
    const registry = await FileResourceRegistry.open({ rootDir: resourcesRoot });
    const skillRef = registry.resolveRef("emi.skill.control-to-trd", "2026.08.21");
    await expect(registry.load(skillRef, "executor")).rejects.toEqual(
      expect.objectContaining<Partial<ResourceRegistryError>>({ code: "role_not_allowed" }),
    );
    await expect(registry.project([skillRef, skillRef], "coordinator")).rejects.toEqual(
      expect.objectContaining<Partial<ResourceRegistryError>>({ code: "duplicate_reference" }),
    );
  });

  it("does not discover resources that are absent from the explicit index", async () => {
    const registry = await FileResourceRegistry.open({ rootDir: resourcesRoot });
    expect(() => registry.resolveRef("emi.unindexed", "1")).toThrowError(
      expect.objectContaining<Partial<ResourceRegistryError>>({ code: "not_found" }),
    );
  });
});
