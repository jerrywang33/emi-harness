import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const targetRoot = process.argv[2];

if (targetRoot === undefined || !isAbsolute(targetRoot)) {
  throw new Error("Usage: pnpm calibrate:v0.1 -- /absolute/path/to/new-target");
}
try {
  await access(targetRoot);
  throw new Error(`Calibration target must not already exist: ${targetRoot}`);
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Calibration target")) throw error;
  if (error === null || typeof error !== "object" || error.code !== "ENOENT") throw error;
}
await access(resolve(targetRoot, ".."));

const pnpmScript = process.env.npm_execpath;
if (pnpmScript === undefined || !isAbsolute(pnpmScript)) {
  throw new Error("Calibration must be launched through the pinned pnpm command");
}

async function run(args, extraEnv = {}) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [pnpmScript, ...args], {
      cwd: root,
      env: { ...process.env, NODE_NO_WARNINGS: "1", ...extraEnv },
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`pnpm ${args.join(" ")} failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

const gitStatus = await new Promise((resolveStatus, rejectStatus) => {
  const chunks = [];
  const child = spawn("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.once("error", rejectStatus);
  child.once("exit", (code) => code === 0
    ? resolveStatus(Buffer.concat(chunks).toString("utf8").trim())
    : rejectStatus(new Error(`git status failed with exit ${code}`)));
});
if (gitStatus !== "") throw new Error("Calibration requires a clean EMI Harness worktree");

await run(["check"]);
await run(
  ["--filter", "@emi-harness/integration", "exec", "vitest", "run", "test/pi-target.e2e.test.ts"],
  { EMI_HARNESS_E2E_TARGET_ROOT: targetRoot },
);

console.log(`Calibration target: ${targetRoot}`);
console.log(`Candidate evidence: ${resolve(targetRoot, ".emi-harness/evidence/run-1.candidate.json")}`);
