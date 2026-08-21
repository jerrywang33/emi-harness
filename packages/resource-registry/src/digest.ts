import { createHash } from "node:crypto";

export function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function isSha256(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}
