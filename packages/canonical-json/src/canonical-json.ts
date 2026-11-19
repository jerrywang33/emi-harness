import { createHash } from "node:crypto";

import type { JsonValue } from "./types.js";

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function assertValidString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= LOW_SURROGATE_START && next <= LOW_SURROGATE_END)) {
        throw new TypeError("Canonical JSON rejects unpaired UTF-16 high surrogates");
      }
      index += 1;
    } else if (code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END) {
      throw new TypeError("Canonical JSON rejects unpaired UTF-16 low surrogates");
    }
  }
}

/** Orders by UTF-16 code units, as RFC 8785 requires for property names. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serialize(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON only accepts finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertValidString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON only accepts plain objects");
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries
      .map(([key, item]) => {
        if (item === undefined) {
          throw new TypeError(`Canonical JSON rejects undefined property: ${key}`);
        }
        assertValidString(key);
        return `${JSON.stringify(key)}:${serialize(item)}`;
      })
      .join(",")}}`;
  }
  throw new TypeError(`Canonical JSON rejects value of type ${typeof value}`);
}

export function canonicalizeJson(value: unknown): string {
  return serialize(value);
}

/** Returns a detached plain-JSON copy, rejecting anything canonicalizeJson rejects. */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalizeJson(value)) as JsonValue;
}

export function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function digestJson(value: unknown): string {
  return sha256Text(canonicalizeJson(value));
}

export function isSha256(value: string): boolean {
  return SHA256.test(value);
}
