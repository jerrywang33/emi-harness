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
  "docs/decisions/0003-use-sqlite-for-v0.1-control-plane.md",
  "docs/design/control-plane-persistence-and-recovery.md",
  "docs/design/control-plane-state-and-run-manifest.md",
  "docs/design/controlled-emi-resources-v0.1.md",
  "docs/design/executor-verifier-assurance-v0.1.md",
  "docs/design/tool-gateway-v0.1.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "roadmap/README.md",
  "scripts/run-v0.1-local-calibration.mjs",
  "tsconfig.base.json",
]) {
  await requirePath(join(root, path));
}

const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (rootPackage.packageManager !== "pnpm@11.7.0") {
  errors.push("package.json must pin pnpm@11.7.0");
}
if (rootPackage.engines?.node !== ">=24.15.0") {
  errors.push("package.json must use the Node.js baseline required by Control Plane SQLite");
}

const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
if (!workspace.includes('"packages/*"')) {
  errors.push('pnpm-workspace.yaml must include "packages/*"');
}
for (const deniedBuild of ["'@google/genai': false", "protobufjs: false"]) {
  if (!workspace.includes(deniedBuild)) {
    errors.push(`pnpm-workspace.yaml must explicitly deny dependency build scripts with: ${deniedBuild}`);
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

const packagesPath = join(root, "packages");
if (await exists(packagesPath)) {
  const entries = await readdir(packagesPath, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const packagePath = join(packagesPath, entry.name, "package.json");
    await requirePath(packagePath);
    if (!(await exists(packagePath))) {
      continue;
    }

    const packageManifest = JSON.parse(await readFile(packagePath, "utf8"));
    if (packageManifest.name !== "@emi-harness/runtime-pi") {
      for (const dependencyGroup of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const dependency of Object.keys(packageManifest[dependencyGroup] ?? {})) {
          if (dependency.startsWith("@earendil-works/pi-")) {
            errors.push(`${relative(root, packagePath)} must not depend directly on Pi package: ${dependency}`);
          }
        }
      }
    }
  }
}

const runtimePiRoot = join(root, "packages/runtime-pi");
for (const path of [
  "README.md",
  "package.json",
  "src/controlled-pi-session-factory.ts",
  "src/index.ts",
  "src/testing/deterministic-pi-runtime-adapter.ts",
  "src/testing/index.ts",
  "test/deterministic-pi-runtime-adapter.test.ts",
  "test/pi-sdk.contract.test.ts",
  "tsconfig.build.json",
  "tsconfig.json",
]) {
  await requirePath(join(runtimePiRoot, path));
}

const controlPlaneRoot = join(root, "packages/control-plane");
for (const path of [
  "README.md",
  "package.json",
  "src/index.ts",
  "src/migrations.ts",
  "src/sqlite-control-plane.ts",
  "test/lifecycle.integration.test.ts",
  "test/recovery.integration.test.ts",
  "tsconfig.build.json",
  "tsconfig.json",
]) {
  await requirePath(join(controlPlaneRoot, path));
}

const resourceRegistryRoot = join(root, "packages/resource-registry");
for (const path of [
  "README.md",
  "package.json",
  "resources/contexts/emi.safeguarding.payment-funds/context.md",
  "resources/contexts/emi.safeguarding.payment-funds/manifest.json",
  "resources/registry.json",
  "resources/skills/emi.skill.control-to-trd/SKILL.md",
  "resources/skills/emi.skill.control-to-trd/manifest.json",
  "schemas/resource-manifest.schema.json",
  "src/index.ts",
  "test/registry.integration.test.ts",
  "test/security.integration.test.ts",
  "tsconfig.build.json",
  "tsconfig.json",
]) {
  await requirePath(join(resourceRegistryRoot, path));
}

const toolGatewayRoot = join(root, "packages/tool-gateway");
for (const path of [
  "README.md",
  "package.json",
  "src/control-plane-authority.ts",
  "src/definitions.ts",
  "src/index.ts",
  "src/migrations.ts",
  "src/sqlite-tool-gateway.ts",
  "src/subprocess-workspace-executor.ts",
  "src/workspace-write-policy.ts",
  "test/gateway.integration.test.ts",
  "test/recovery.integration.test.ts",
  "tsconfig.build.json",
  "tsconfig.json",
  "worker/workspace-worker.mjs",
]) {
  await requirePath(join(toolGatewayRoot, path));
}

const assuranceRoot = join(root, "packages/assurance");
for (const path of [
  "README.md",
  "package.json",
  "src/assurance-service.ts",
  "src/index.ts",
  "src/migrations.ts",
  "src/node-check-runner.ts",
  "src/sqlite-evidence-store.ts",
  "test/assurance-service.test.ts",
  "test/evidence-store.integration.test.ts",
  "test/node-check-runner.integration.test.ts",
  "tsconfig.build.json",
  "tsconfig.json",
]) {
  await requirePath(join(assuranceRoot, path));
}

const integrationRoot = join(root, "packages/integration");
for (const path of [
  "README.md",
  "package.json",
  "src/candidate-evidence-package.ts",
  "src/gateway-runtime-tool.ts",
  "src/index.ts",
  "src/role-execution-coordinator.ts",
  "src/submission-tools.ts",
  "test/pi-target.e2e.test.ts",
  "test/role-execution.integration.test.ts",
  "test/submission-tools.test.ts",
  "tsconfig.build.json",
  "tsconfig.json",
]) {
  await requirePath(join(integrationRoot, path));
}
if (await exists(join(runtimePiRoot, "package.json"))) {
  const runtimePiPackage = JSON.parse(await readFile(join(runtimePiRoot, "package.json"), "utf8"));
  for (const piPackage of [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
  ]) {
    if (runtimePiPackage.dependencies?.[piPackage] !== "0.84.2") {
      errors.push(`packages/runtime-pi/package.json must pin ${piPackage} to 0.84.2`);
    }
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
