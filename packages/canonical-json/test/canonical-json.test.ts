import { describe, expect, it } from "vitest";

import { canonicalizeJson, cleanRef, compareRefs, digestJson, isSha256, sameRef, sha256Text } from "../src/index.js";

describe("canonical JSON", () => {
  it("uses deterministic RFC 8785 property ordering and ECMAScript number encoding", () => {
    expect(canonicalizeJson({ string: "€$\u000f\nA'B\"\\\"/", numbers: [333333333.3333333, 1e30, 4.5, 0.002, 1e-27] })).toBe(
      "{\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
    );
  });

  it("sorts property names by UTF-16 code units at every depth", () => {
    expect(canonicalizeJson({ "\u20ac": 1, "\r": 2, "\ud83d\ude00": 3, "\ufb33": 4, "1": { b: [], a: null } })).toBe(
      "{\"\\r\":2,\"1\":{\"a\":null,\"b\":[]},\"\u20ac\":1,\"\ud83d\ude00\":3,\"\ufb33\":4}",
    );
  });

  it("rejects values that JSON would silently coerce", () => {
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrow("finite numbers");
    expect(() => canonicalizeJson({ value: Number.POSITIVE_INFINITY })).toThrow("finite numbers");
    expect(() => canonicalizeJson({ value: undefined })).toThrow("undefined property");
    expect(() => canonicalizeJson({ value: "\ud800" })).toThrow("unpaired");
    expect(() => canonicalizeJson({ value: "\udc00" })).toThrow("unpaired");
    expect(() => canonicalizeJson({ value: new Date(0) })).toThrow("plain objects");
    expect(() => canonicalizeJson({ value: 1n })).toThrow("type bigint");
    expect(canonicalizeJson(Object.assign(Object.create(null), { a: 1 }))).toBe("{\"a\":1}");
  });

  it("keeps the digest format used by sealed v0.1 records", () => {
    expect(sha256Text("")).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(digestJson({ b: 1, a: "x" })).toBe(sha256Text("{\"a\":\"x\",\"b\":1}"));
    expect(isSha256(sha256Text("x"))).toBe(true);
    expect(isSha256("sha256:ABC")).toBe(false);
    expect(isSha256(`${sha256Text("x")}0`)).toBe(false);
  });
});

describe("VersionedRef", () => {
  const a = { id: "a", version: "1", digest: sha256Text("a") };
  const b = { id: "a", version: "2", digest: sha256Text("b") };

  it("compares all identity fields and orders deterministically", () => {
    expect(sameRef(a, { ...a })).toBe(true);
    expect(sameRef(a, { ...a, digest: b.digest })).toBe(false);
    expect([b, a].sort(compareRefs)).toEqual([a, b]);
  });

  it("copies only identity fields", () => {
    expect(cleanRef({ ...a, extra: true } as typeof a)).toEqual(a);
  });
});
