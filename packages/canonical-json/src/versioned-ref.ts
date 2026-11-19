import { compareText } from "./canonical-json.js";
import type { VersionedRef } from "./types.js";

export function refKey(ref: VersionedRef): string {
  return `${ref.id}\u0000${ref.version}\u0000${ref.digest}`;
}

export function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}

export function compareRefs(left: VersionedRef, right: VersionedRef): number {
  return compareText(refKey(left), refKey(right));
}

/** Drops any extra properties so only the three identity fields are serialized. */
export function cleanRef(ref: VersionedRef): VersionedRef {
  return { id: ref.id, version: ref.version, digest: ref.digest };
}
