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
if (rootPackage.engines?.node !== "^22.19.0 || >=24.0.0") {
  errors.push("package.json must use the DeepSeek Harness Node.js compatibility range");
}

const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
for (const pattern of ["packages/bundle/*", "packages/plugin/*"]) {
  if (!workspace.includes(pattern)) {
    errors.push(`pnpm-workspace.yaml must include ${pattern}`);
  }
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

for (const [group, isBundle] of [
  ["packages/bundle", true],
  ["packages/plugin", false],
]) {
  const groupPath = join(root, group);
  if (!(await exists(groupPath))) {
    continue;
  }

  const entries = await readdir(groupPath, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const packagePath = join(groupPath, entry.name);
    await requirePath(join(packagePath, "package.json"));
    if (isBundle) {
      await requirePath(join(packagePath, "cordis.patch.yml"));
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
