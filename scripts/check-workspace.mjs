import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const errors = [];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function requirePath(path) {
  if (!(await exists(path))) {
    errors.push(`Missing required path: ${relative(root, path)}`);
  }
}

for (const path of [
  "AGENTS.md",
  "README.md",
  "docs/decisions/0001-rebuild-on-deepseek-harness.md",
  "docs/decisions/0002-adopt-pi-runtime-with-emi-control-plane.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "roadmap/README.md",
]) {
  await requirePath(join(root, path));
}

const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (rootPackage.packageManager !== "pnpm@11.7.0") {
  errors.push("package.json must pin pnpm@11.7.0");
}
if (rootPackage.engines?.node !== ">=22.19.0") {
  errors.push("package.json must use the Pi Node.js compatibility range");
}

const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
if (!workspace.includes('"packages/*"')) {
  errors.push('pnpm-workspace.yaml must include "packages/*"');
}

for (const legacyPath of [
  "conventions",
  "harness",
  "reports",
  "scaffolds",
  "skills",
  "specs",
  "templates",
]) {
  if (await exists(join(root, legacyPath))) {
    errors.push(`Legacy path must not exist: ${legacyPath}`);
  }
}

const packagesPath = join(root, "packages");
if (await exists(packagesPath)) {
  const entries = await readdir(packagesPath, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory())) {
    await requirePath(join(packagesPath, entry.name, "package.json"));
  }
}

for (const path of ["AGENTS.md", "README.md", "roadmap/README.md", "package.json", "pnpm-workspace.yaml"]) {
  const content = await readFile(join(root, path), "utf8");
  for (const staleTerm of [
    "$DSH_HOME",
    "dsh.profile",
    "packages/bundle",
    "packages/plugin",
    "Spring Boot",
    "Maven",
    "src/main/java",
  ]) {
    if (content.includes(staleTerm)) {
      errors.push(`${path} contains superseded implementation term: ${staleTerm}`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log("Workspace structure is valid.");
}
