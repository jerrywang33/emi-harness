import { isSha256 } from "./digest.js";
import { fail } from "./errors.js";
import type {
  ContextStatement,
  EmiContextManifestV1,
  PromptManifestV1,
  RegulatorySource,
  ResourceContentDescriptor,
  ResourceGovernance,
  ResourceManifestV1,
  ResourceRegistryIndexV1,
  ResourceRole,
  SkillManifestV1,
} from "./types.js";

type UnknownObject = Record<string, unknown>;

function exactKeys(input: UnknownObject, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      fail("invalid_manifest", `${label} contains unsupported property: ${key}`);
    }
  }
}

function object(value: unknown, label: string): UnknownObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail("invalid_manifest", `${label} must be an object`);
  }
  return value as UnknownObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("invalid_manifest", `${label} must be a non-empty string`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    fail("invalid_manifest", `${label} must be a boolean`);
  }
  return value;
}

function stringArray(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail("invalid_manifest", `${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const result = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    fail("invalid_manifest", `${label} must not contain duplicates`);
  }
  return result;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const result = text(value, label);
  if (!allowed.includes(result as T)) {
    fail("invalid_manifest", `${label} has unsupported value: ${result}`);
  }
  return result as T;
}

function isoDate(value: unknown, label: string): string {
  const result = text(value, label);
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== result
  ) {
    fail("invalid_manifest", `${label} must be YYYY-MM-DD`);
  }
  return result;
}

function content(value: unknown): ResourceContentDescriptor {
  const input = object(value, "content");
  exactKeys(input, ["path", "mediaType", "digest"], "content");
  const digest = text(input.digest, "content.digest");
  if (!isSha256(digest)) {
    fail("invalid_manifest", "content.digest must be sha256 lowercase hex");
  }
  return {
    path: text(input.path, "content.path"),
    mediaType: oneOf(input.mediaType, ["text/markdown", "text/plain"], "content.mediaType"),
    digest,
  };
}

function governance(value: unknown): ResourceGovernance {
  const input = object(value, "governance");
  exactKeys(input, ["owner", "preparedAt", "nextReviewAt", "changePolicy", "confirmationStatus"], "governance");
  const preparedAt = isoDate(input.preparedAt, "governance.preparedAt");
  const nextReviewAt = isoDate(input.nextReviewAt, "governance.nextReviewAt");
  if (nextReviewAt <= preparedAt) {
    fail("invalid_manifest", "governance.nextReviewAt must be after preparedAt");
  }
  return {
    owner: text(input.owner, "governance.owner"),
    preparedAt,
    nextReviewAt,
    changePolicy: oneOf(input.changePolicy, ["manual_review"], "governance.changePolicy"),
    confirmationStatus: oneOf(
      input.confirmationStatus,
      ["engineering_baseline", "human_confirmed", "source_baseline_task_confirmation_required"],
      "governance.confirmationStatus",
    ),
  };
}

function source(value: unknown, index: number): RegulatorySource {
  const input = object(value, `sources[${index}]`);
  exactKeys(
    input,
    [
      "sourceId",
      "authority",
      "documentTitle",
      "documentId",
      "versionDate",
      "locator",
      "canonicalUrl",
      "retrievedAt",
      "supportStatus",
    ],
    `sources[${index}]`,
  );
  const canonicalUrl = text(input.canonicalUrl, `sources[${index}].canonicalUrl`);
  let url: URL;
  try {
    url = new URL(canonicalUrl);
  } catch {
    fail("invalid_manifest", `sources[${index}].canonicalUrl must be a URL`);
  }
  if (url.protocol !== "https:" || url.hostname !== "eur-lex.europa.eu") {
    fail("invalid_manifest", `sources[${index}] must use an official EUR-Lex HTTPS URL`);
  }
  return {
    sourceId: text(input.sourceId, `sources[${index}].sourceId`),
    authority: text(input.authority, `sources[${index}].authority`),
    documentTitle: text(input.documentTitle, `sources[${index}].documentTitle`),
    documentId: text(input.documentId, `sources[${index}].documentId`),
    versionDate: isoDate(input.versionDate, `sources[${index}].versionDate`),
    locator: text(input.locator, `sources[${index}].locator`),
    canonicalUrl,
    retrievedAt: isoDate(input.retrievedAt, `sources[${index}].retrievedAt`),
    supportStatus: oneOf(input.supportStatus, ["source_supported", "context_only"], `sources[${index}].supportStatus`),
  };
}

function statement(value: unknown, index: number, sourceIds: ReadonlySet<string>): ContextStatement {
  const input = object(value, `statements[${index}]`);
  exactKeys(input, ["statementId", "classification", "sourceRefs", "taskConfirmationRequired"], `statements[${index}]`);
  const sourceRefs = stringArray(input.sourceRefs, `statements[${index}].sourceRefs`, true);
  for (const sourceRef of sourceRefs) {
    if (!sourceIds.has(sourceRef)) {
      fail("invalid_manifest", `Statement references unknown source: ${sourceRef}`);
    }
  }
  const classification = oneOf(
    input.classification,
    ["source_supported", "engineering_derived", "task_confirmation_required"],
    `statements[${index}].classification`,
  );
  const taskConfirmationRequired = boolean(input.taskConfirmationRequired, `statements[${index}].taskConfirmationRequired`);
  if (classification === "source_supported" && sourceRefs.length === 0) {
    fail("invalid_manifest", `Source-supported statement requires a source: ${String(input.statementId)}`);
  }
  if (classification !== "source_supported" && !taskConfirmationRequired) {
    fail("invalid_manifest", `Derived or unresolved statement must require task confirmation: ${String(input.statementId)}`);
  }
  return {
    statementId: text(input.statementId, `statements[${index}].statementId`),
    classification,
    sourceRefs,
    taskConfirmationRequired,
  };
}

function base(input: UnknownObject): Pick<ResourceManifestV1, "schemaVersion" | "resourceId" | "version" | "status" | "title" | "content" | "governance"> {
  return {
    schemaVersion: oneOf(input.schemaVersion, ["1"], "schemaVersion"),
    resourceId: text(input.resourceId, "resourceId"),
    version: text(input.version, "version"),
    status: oneOf(input.status, ["active", "draft", "retired"], "status"),
    title: text(input.title, "title"),
    content: content(input.content),
    governance: governance(input.governance),
  };
}

export function validateResourceManifest(value: unknown): ResourceManifestV1 {
  const input = object(value, "ResourceManifest");
  const common = base(input);
  const kind = oneOf(input.kind, ["emi_context", "skill", "prompt"], "kind");
  if (kind === "emi_context") {
    exactKeys(
      input,
      ["schemaVersion", "resourceId", "version", "kind", "status", "title", "content", "governance", "applicability", "sources", "statements"],
      "ResourceManifest",
    );
    const applicability = object(input.applicability, "applicability");
    exactKeys(
      applicability,
      ["jurisdictions", "regulatedEntityTypes", "businessActivities", "exclusions", "taskConfirmationRequired"],
      "applicability",
    );
    const sourcesInput = input.sources;
    if (!Array.isArray(sourcesInput) || sourcesInput.length === 0) {
      fail("invalid_manifest", "EMI Context requires at least one source");
    }
    const sources = sourcesInput.map(source);
    const sourceIds = new Set(sources.map((item) => item.sourceId));
    if (sourceIds.size !== sources.length) {
      fail("invalid_manifest", "EMI Context source IDs must be unique");
    }
    if (!Array.isArray(input.statements) || input.statements.length === 0) {
      fail("invalid_manifest", "EMI Context requires statements");
    }
    const statements = input.statements.map((item, index) => statement(item, index, sourceIds));
    const statementIds = new Set(statements.map((item) => item.statementId));
    if (statementIds.size !== statements.length) {
      fail("invalid_manifest", "EMI Context statement IDs must be unique");
    }
    return {
      ...common,
      kind,
      applicability: {
        jurisdictions: stringArray(applicability.jurisdictions, "applicability.jurisdictions"),
        regulatedEntityTypes: stringArray(applicability.regulatedEntityTypes, "applicability.regulatedEntityTypes"),
        businessActivities: stringArray(applicability.businessActivities, "applicability.businessActivities"),
        exclusions: stringArray(applicability.exclusions, "applicability.exclusions", true),
        taskConfirmationRequired: boolean(applicability.taskConfirmationRequired, "applicability.taskConfirmationRequired"),
      },
      sources,
      statements,
    } satisfies EmiContextManifestV1;
  }
  if (kind === "skill") {
    exactKeys(
      input,
      ["schemaVersion", "resourceId", "version", "kind", "status", "title", "content", "governance", "skill"],
      "ResourceManifest",
    );
    const skill = object(input.skill, "skill");
    exactKeys(skill, ["allowedRoles", "requiredInputs", "outputs", "prohibitedActions"], "skill");
    return {
      ...common,
      kind,
      skill: {
        allowedRoles: stringArray(skill.allowedRoles, "skill.allowedRoles").map((role) =>
          oneOf(role, ["coordinator", "executor", "verifier"], "skill.allowedRole"),
        ) as ResourceRole[],
        requiredInputs: stringArray(skill.requiredInputs, "skill.requiredInputs"),
        outputs: stringArray(skill.outputs, "skill.outputs"),
        prohibitedActions: stringArray(skill.prohibitedActions, "skill.prohibitedActions"),
      },
    } satisfies SkillManifestV1;
  }
  exactKeys(
    input,
    ["schemaVersion", "resourceId", "version", "kind", "status", "title", "content", "governance", "prompt"],
    "ResourceManifest",
  );
  const prompt = object(input.prompt, "prompt");
  exactKeys(prompt, ["allowedRoles"], "prompt");
  return {
    ...common,
    kind,
    prompt: {
      allowedRoles: stringArray(prompt.allowedRoles, "prompt.allowedRoles").map((role) =>
        oneOf(role, ["coordinator", "executor", "verifier"], "prompt.allowedRole"),
      ) as ResourceRole[],
    },
  } satisfies PromptManifestV1;
}

export function validateRegistryIndex(value: unknown): ResourceRegistryIndexV1 {
  const input = object(value, "ResourceRegistryIndex");
  exactKeys(input, ["schemaVersion", "resources"], "ResourceRegistryIndex");
  if (input.schemaVersion !== "1" || !Array.isArray(input.resources)) {
    fail("invalid_manifest", "Resource Registry index must use schemaVersion 1 and a resources array");
  }
  const keys = new Set<string>();
  const resources = input.resources.map((value, index) => {
    const entry = object(value, `resources[${index}]`);
    exactKeys(entry, ["id", "version", "digest", "manifestPath"], `resources[${index}]`);
    const id = text(entry.id, `resources[${index}].id`);
    const version = text(entry.version, `resources[${index}].version`);
    const digest = text(entry.digest, `resources[${index}].digest`);
    if (!isSha256(digest)) {
      fail("invalid_manifest", `resources[${index}].digest must be sha256 lowercase hex`);
    }
    const key = `${id}\u0000${version}`;
    if (keys.has(key)) {
      fail("invalid_manifest", `Duplicate Resource Registry entry: ${id}@${version}`);
    }
    keys.add(key);
    return { id, version, digest, manifestPath: text(entry.manifestPath, `resources[${index}].manifestPath`) };
  });
  return { schemaVersion: "1", resources };
}
