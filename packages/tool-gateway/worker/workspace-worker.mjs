import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_CONTENT_BYTES = 128 * 1024;
const MAX_EXISTING_BYTES = 1024 * 1024;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function respond(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function exactKeys(value, keys, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function validateRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("path is not a normalized repository-relative path");
  }
}

function inside(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function resolveTarget(rootDir, relativePath) {
  if (!isAbsolute(rootDir)) {
    throw new Error("workspace root must be absolute");
  }
  validateRelativePath(relativePath);
  const root = await realpath(rootDir);
  const segments = relativePath.split("/");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    const candidate = join(parent, segment);
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("workspace parent must be a real directory");
    }
    parent = await realpath(candidate);
    if (!inside(root, parent)) {
      throw new Error("workspace parent escapes the configured root");
    }
  }
  const target = join(parent, segments.at(-1));
  if (!inside(root, target)) {
    throw new Error("workspace target escapes the configured root");
  }
  return { root, target };
}

async function inspectTarget(rootDir, path) {
  const { root, target } = await resolveTarget(rootDir, path);
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { root, target, exists: false };
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("workspace target must be a regular file or absent");
  }
  const actual = await realpath(target);
  if (!inside(root, actual)) {
    throw new Error("workspace target resolves outside the configured root");
  }
  if (stat.size > MAX_EXISTING_BYTES) {
    throw new Error("workspace target exceeds the reconciliation read limit");
  }
  const content = await readFile(actual, "utf8");
  return { root, target, exists: true, digest: sha256(content), mode: stat.mode & 0o777 };
}

function validateIntent(request) {
  exactKeys(request, ["protocolVersion", "action", "operationId", "rootDir", "intent"], "request");
  if (request.protocolVersion !== "1" || !["execute", "reconcile"].includes(request.action)) {
    throw new Error("unsupported worker protocol");
  }
  if (typeof request.operationId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/u.test(request.operationId)) {
    throw new Error("invalid operation ID");
  }
  exactKeys(request.intent, ["toolName", "toolVersion", "input"], "intent");
  if (request.intent.toolName !== "workspace.write_text" || request.intent.toolVersion !== "1") {
    throw new Error("unsupported tool");
  }
  exactKeys(request.intent.input, ["path", "content", "expectedDigest"], "intent.input");
  const { path, content, expectedDigest } = request.intent.input;
  validateRelativePath(path);
  if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw new Error("invalid workspace content");
  }
  if (typeof expectedDigest !== "string" || (expectedDigest !== "absent" && !/^sha256:[0-9a-f]{64}$/u.test(expectedDigest))) {
    throw new Error("invalid expected digest");
  }
  return { path, content, expectedDigest };
}

function evidence(path, digest) {
  return [`workspace-file:${path}:${digest}`];
}

async function execute(request, input) {
  let before;
  try {
    before = await inspectTarget(request.rootDir, input.path);
  } catch (error) {
    return {
      protocolVersion: "1",
      action: "execute",
      outcome: "failed",
      output: { path: input.path },
      evidenceRefs: [],
      errorCode: "unsafe_target",
      sanitizedError: error instanceof Error ? error.message : "Workspace target is unsafe",
    };
  }
  const contentDigest = sha256(input.content);
  if (before.exists && before.digest === contentDigest) {
    return {
      protocolVersion: "1",
      action: "execute",
      outcome: "succeeded",
      output: { path: input.path, contentDigest, previousDigest: before.digest, alreadyApplied: true },
      evidenceRefs: evidence(input.path, contentDigest),
    };
  }
  const matchesExpected = input.expectedDigest === "absent"
    ? !before.exists
    : before.exists && before.digest === input.expectedDigest;
  if (!matchesExpected) {
    return {
      protocolVersion: "1",
      action: "execute",
      outcome: "failed",
      output: { path: input.path, observedDigest: before.exists ? before.digest : "absent" },
      evidenceRefs: [],
      errorCode: "precondition_failed",
      sanitizedError: "Current file digest does not match expectedDigest",
    };
  }
  const temporary = join(before.target.slice(0, before.target.lastIndexOf(sep)), `.emi-${request.operationId}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, before.exists ? before.mode : 0o600);
    await handle.writeFile(input.content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, before.target);
    const directory = await open(before.target.slice(0, before.target.lastIndexOf(sep)), constants.O_RDONLY);
    await directory.sync();
    await directory.close();
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  const after = await inspectTarget(request.rootDir, input.path);
  if (!after.exists || after.digest !== contentDigest) {
    throw new Error("atomic write completed without the expected target digest");
  }
  return {
    protocolVersion: "1",
    action: "execute",
    outcome: "succeeded",
    output: {
      path: input.path,
      contentDigest,
      previousDigest: before.exists ? before.digest : "absent",
      alreadyApplied: false,
    },
    evidenceRefs: evidence(input.path, contentDigest),
  };
}

async function reconcile(request, input) {
  let current;
  try {
    current = await inspectTarget(request.rootDir, input.path);
  } catch (error) {
    return {
      protocolVersion: "1",
      action: "reconcile",
      outcome: "unknown",
      output: { path: input.path },
      evidenceRefs: [],
      errorCode: "unsafe_or_unreadable_target",
      sanitizedError: error instanceof Error ? error.message : "Workspace target cannot be inspected safely",
    };
  }
  const contentDigest = sha256(input.content);
  if (current.exists && current.digest === contentDigest) {
    return {
      protocolVersion: "1",
      action: "reconcile",
      outcome: "applied",
      output: { path: input.path, contentDigest },
      evidenceRefs: evidence(input.path, contentDigest),
    };
  }
  const unchanged = input.expectedDigest === "absent"
    ? !current.exists
    : current.exists && current.digest === input.expectedDigest;
  if (unchanged) {
    return {
      protocolVersion: "1",
      action: "reconcile",
      outcome: "not_applied",
      output: { path: input.path, observedDigest: current.exists ? current.digest : "absent" },
      evidenceRefs: [],
      errorCode: "not_applied",
      sanitizedError: "Target remains at the expected pre-operation state",
    };
  }
  return {
    protocolVersion: "1",
    action: "reconcile",
    outcome: "unknown",
    output: { path: input.path, observedDigest: current.exists ? current.digest : "absent" },
    evidenceRefs: current.exists ? evidence(input.path, current.digest) : [],
    errorCode: "target_diverged",
    sanitizedError: "Target differs from both the expected old state and intended new state",
  };
}

async function readRequest() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) {
      throw new Error("worker request exceeds size limit");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

try {
  const request = await readRequest();
  const input = validateIntent(request);
  respond(request.action === "execute" ? await execute(request, input) : await reconcile(request, input));
} catch {
  process.exitCode = 1;
}
