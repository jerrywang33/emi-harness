import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileResourceRegistry,
  ResourceRegistryError,
  sha256Text,
  validateResourceManifest,
} from "../src/index.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../resources");
const directories: string[] = [];

async function copiedRegistry(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "emi-resources-"));
  directories.push(directory);
  const root = join(directory, "resources");
  await cp(sourceRoot, root, { recursive: true });
  return root;
}

async function updateManifest(
  root: string,
  resourceId: string,
  update: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const registryPath = join(root, "registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
    resources: { id: string; digest: string; manifestPath: string }[];
  };
  const entry = registry.resources.find((candidate) => candidate.id === resourceId);
  if (entry === undefined) {
    throw new Error(`Missing test resource: ${resourceId}`);
  }
  const manifestPath = join(root, entry.manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  update(manifest);
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, raw, "utf8");
  entry.digest = sha256Text(raw);
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Resource Registry trust boundary", () => {
  it("detects content tampering after the Manifest was pinned", async () => {
    const root = await copiedRegistry();
    await writeFile(
      join(root, "contexts/emi.safeguarding.payment-funds/context.md"),
      "tampered context\n",
      "utf8",
    );
    const registry = await FileResourceRegistry.open({ rootDir: root });
    const ref = registry.resolveRef("emi.safeguarding.payment-funds", "2026.08.21");
    await expect(registry.load(ref, "coordinator")).rejects.toEqual(
      expect.objectContaining<Partial<ResourceRegistryError>>({ code: "digest_mismatch" }),
    );
  });

  it("rejects a correctly hashed but inactive resource", async () => {
    const root = await copiedRegistry();
    await updateManifest(root, "emi.skill.control-to-trd", (manifest) => {
      manifest.status = "draft";
    });
    const registry = await FileResourceRegistry.open({ rootDir: root });
    const ref = registry.resolveRef("emi.skill.control-to-trd", "2026.08.21");
    await expect(registry.load(ref, "coordinator")).rejects.toEqual(
      expect.objectContaining<Partial<ResourceRegistryError>>({ code: "inactive_resource" }),
    );
  });

  it("rejects parent traversal before reading a Manifest", async () => {
    const root = await copiedRegistry();
    const registryPath = join(root, "registry.json");
    const registryJson = JSON.parse(await readFile(registryPath, "utf8")) as {
      resources: { id: string; digest: string; manifestPath: string }[];
    };
    const entry = registryJson.resources[0];
    if (entry === undefined) {
      throw new Error("Missing Registry entry");
    }
    entry.manifestPath = "../outside.json";
    await writeFile(registryPath, `${JSON.stringify(registryJson, null, 2)}\n`, "utf8");
    const registry = await FileResourceRegistry.open({ rootDir: root });
    const ref = registry.resolveRef(entry.id, "2026.08.21");
    await expect(registry.load(ref, "coordinator")).rejects.toEqual(
      expect.objectContaining<Partial<ResourceRegistryError>>({ code: "invalid_path" }),
    );
  });

  it("rejects parent traversal from a Manifest content path", async () => {
    const root = await copiedRegistry();
    await updateManifest(root, "emi.skill.control-to-trd", (manifest) => {
      const content = manifest.content as Record<string, unknown>;
      content.path = "../../outside.md";
    });
    const registry = await FileResourceRegistry.open({ rootDir: root });
    const ref = registry.resolveRef("emi.skill.control-to-trd", "2026.08.21");
    await expect(registry.load(ref, "coordinator")).rejects.toEqual(
      expect.objectContaining<Partial<ResourceRegistryError>>({ code: "invalid_path" }),
    );
  });

  it("rejects non-authoritative regulatory source URLs", async () => {
    const manifestPath = join(sourceRoot, "contexts/emi.safeguarding.payment-funds/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sources: { canonicalUrl: string }[];
    };
    const changed = structuredClone(manifest);
    const first = changed.sources[0];
    if (first === undefined) {
      throw new Error("Missing source");
    }
    first.canonicalUrl = "https://example.com/uncontrolled-copy";
    expect(() => validateResourceManifest(changed)).toThrowError(
      expect.objectContaining<Partial<ResourceRegistryError>>({ code: "invalid_manifest" }),
    );
  });

  it("rejects unknown fields and duplicate Statement IDs", async () => {
    const manifestPath = join(sourceRoot, "contexts/emi.safeguarding.payment-funds/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & {
      statements: Record<string, unknown>[];
    };
    const withUnknownField = structuredClone(manifest);
    withUnknownField.unreviewed = true;
    expect(() => validateResourceManifest(withUnknownField)).toThrowError(
      expect.objectContaining<Partial<ResourceRegistryError>>({ code: "invalid_manifest" }),
    );

    const withDuplicate = structuredClone(manifest);
    const first = withDuplicate.statements[0];
    const second = withDuplicate.statements[1];
    if (first === undefined || second === undefined) {
      throw new Error("Missing statements");
    }
    second.statementId = first.statementId;
    expect(() => validateResourceManifest(withDuplicate)).toThrowError(
      expect.objectContaining<Partial<ResourceRegistryError>>({ code: "invalid_manifest" }),
    );
  });
});
