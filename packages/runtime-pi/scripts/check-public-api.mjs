import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entrypoint = resolve(packageRoot, "dist/index.d.ts");
const visited = new Set();
const piImports = [];

async function inspectDeclaration(path) {
  if (visited.has(path)) {
    return;
  }
  visited.add(path);

  const content = await readFile(path, "utf8");
  if (content.includes("@earendil-works/")) {
    piImports.push(path);
  }

  const relativeImport = /(?:from\s+|import\s*\()\s*["'](\.[^"']+)["']/gu;
  for (const match of content.matchAll(relativeImport)) {
    const specifier = match[1];
    if (specifier === undefined) {
      continue;
    }
    const declaration = resolve(dirname(path), specifier.replace(/\.js$/u, ".d.ts"));
    await inspectDeclaration(declaration);
  }
}

await inspectDeclaration(entrypoint);

if (piImports.length > 0) {
  console.error("Pi types leaked through the public runtime-pi declaration graph:");
  for (const path of piImports) {
    console.error(`- ${path}`);
  }
  process.exitCode = 1;
} else {
  console.log("runtime-pi public declarations do not expose Pi types.");
}
