import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Text } from "./digest.js";
import { fail } from "./errors.js";
import type {
  ControlledResourceProjection,
  LoadedResource,
  RegistryEntry,
  ResourceRegistryIndexV1,
  ResourceRole,
  VersionedRef,
} from "./types.js";
import { validateRegistryIndex, validateResourceManifest } from "./validation.js";

export interface FileResourceRegistryConfig {
  rootDir: string;
  indexPath?: string;
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

export class FileResourceRegistry {
  private constructor(
    private readonly rootDir: string,
    private readonly index: ResourceRegistryIndexV1,
    private readonly maxFileBytes: number,
  ) {}

  static async open(config: FileResourceRegistryConfig): Promise<FileResourceRegistry> {
    if (!isAbsolute(config.rootDir)) {
      fail("invalid_path", "Resource Registry rootDir must be absolute");
    }
    const rootDir = await realpath(config.rootDir);
    const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
      fail("invalid_manifest", "maxFileBytes must be a positive integer");
    }
    const indexPath = config.indexPath ?? "registry.json";
    const rawIndex = await FileResourceRegistry.readSafe(rootDir, indexPath, maxFileBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawIndex);
    } catch {
      fail("invalid_manifest", "Resource Registry index is not valid JSON");
    }
    return new FileResourceRegistry(rootDir, validateRegistryIndex(parsed), maxFileBytes);
  }

  static async openBundled(): Promise<FileResourceRegistry> {
    return FileResourceRegistry.open({
      rootDir: resolve(dirname(fileURLToPath(import.meta.url)), "../resources"),
    });
  }

  listRefs(): VersionedRef[] {
    return this.index.resources.map(({ id, version, digest }) => ({ id, version, digest }));
  }

  resolveRef(resourceId: string, version: string): VersionedRef {
    const entry = this.findEntry(resourceId, version);
    return { id: entry.id, version: entry.version, digest: entry.digest };
  }

  async load(ref: VersionedRef, role: ResourceRole): Promise<LoadedResource> {
    const entry = this.findEntry(ref.id, ref.version);
    if (entry.digest !== ref.digest) {
      fail("digest_mismatch", `Run reference does not match Registry index: ${ref.id}@${ref.version}`);
    }
    const rawManifest = await FileResourceRegistry.readSafe(this.rootDir, entry.manifestPath, this.maxFileBytes);
    if (sha256Text(rawManifest) !== entry.digest) {
      fail("digest_mismatch", `Resource Manifest digest mismatch: ${ref.id}@${ref.version}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawManifest);
    } catch {
      fail("invalid_manifest", `Resource Manifest is not valid JSON: ${ref.id}@${ref.version}`);
    }
    const manifest = validateResourceManifest(parsed);
    if (manifest.resourceId !== ref.id || manifest.version !== ref.version) {
      fail("digest_mismatch", `Resource Manifest identity does not match Registry entry: ${ref.id}@${ref.version}`);
    }
    if (manifest.status !== "active") {
      fail("inactive_resource", `Resource is not active: ${ref.id}@${ref.version}`);
    }
    if (
      (manifest.kind === "skill" && !manifest.skill.allowedRoles.includes(role)) ||
      (manifest.kind === "prompt" && !manifest.prompt.allowedRoles.includes(role))
    ) {
      fail("role_not_allowed", `Role ${role} cannot load ${manifest.kind}: ${ref.id}@${ref.version}`);
    }
    FileResourceRegistry.assertRelativePath(manifest.content.path);
    const contentPath = join(dirname(entry.manifestPath), manifest.content.path);
    const content = await FileResourceRegistry.readSafe(this.rootDir, contentPath, this.maxFileBytes);
    if (sha256Text(content) !== manifest.content.digest) {
      fail("digest_mismatch", `Resource content digest mismatch: ${ref.id}@${ref.version}`);
    }
    return {
      ref: { id: ref.id, version: ref.version, digest: ref.digest },
      manifest,
      content,
      source: `emi-resource:${ref.id}@${ref.version}`,
    };
  }

  async project(refs: readonly VersionedRef[], role: ResourceRole): Promise<ControlledResourceProjection> {
    const keys = new Set<string>();
    const loaded: LoadedResource[] = [];
    for (const ref of refs) {
      const key = `${ref.id}\u0000${ref.version}`;
      if (keys.has(key)) {
        fail("duplicate_reference", `Resource requested more than once: ${ref.id}@${ref.version}`);
      }
      keys.add(key);
      loaded.push(await this.load(ref, role));
    }
    return {
      appendSystemPrompts: loaded
        .filter((resource) => resource.manifest.kind === "skill" || resource.manifest.kind === "prompt")
        .map(({ source, content }) => ({ source, content })),
      contextFiles: loaded
        .filter((resource) => resource.manifest.kind === "emi_context")
        .map(({ source, content }) => ({ source, content })),
    };
  }

  private findEntry(resourceId: string, version: string): RegistryEntry {
    const entry = this.index.resources.find((candidate) => candidate.id === resourceId && candidate.version === version);
    if (entry === undefined) {
      fail("not_found", `Resource is not in the explicit Registry index: ${resourceId}@${version}`);
    }
    return entry;
  }

  private static async readSafe(rootDir: string, relativePath: string, maxFileBytes: number): Promise<string> {
    FileResourceRegistry.assertRelativePath(relativePath);
    const requested = resolve(rootDir, relativePath);
    const actual = await realpath(requested).catch(() => fail("not_found", `Resource file not found: ${relativePath}`));
    if (actual !== rootDir && !actual.startsWith(`${rootDir}${sep}`)) {
      fail("invalid_path", `Resource path escapes the Registry root: ${relativePath}`);
    }
    const content = await readFile(actual, "utf8");
    if (Buffer.byteLength(content, "utf8") > maxFileBytes) {
      fail("invalid_manifest", `Resource file exceeds maxFileBytes: ${relativePath}`);
    }
    return content;
  }

  private static assertRelativePath(relativePath: string): void {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/u).some((segment) => segment === ".." || segment === "." || segment === "")) {
      fail("invalid_path", `Resource path must be a normalized relative path: ${relativePath}`);
    }
  }
}
