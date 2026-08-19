import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, computeDigest, sha256Of, toJson } from "../src/canonical.ts";
import { SkillLockError } from "../src/errors.ts";

test("object keys are serialised in sorted order regardless of insertion order", () => {
  const a = canonicalJson({ b: 1, a: 2, c: 3 });
  const b = canonicalJson({ c: 3, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":3}');
});

test("nested objects are sorted at every level", () => {
  assert.equal(
    canonicalJson({ z: { y: 1, x: 2 }, a: [{ n: 1, m: 2 }] }),
    '{"a":[{"m":2,"n":1}],"z":{"x":2,"y":1}}',
  );
});

test("array order is preserved, because array order is meaningful", () => {
  assert.equal(canonicalJson(["b", "a"]), '["b","a"]');
  assert.notEqual(canonicalJson(["b", "a"]), canonicalJson(["a", "b"]));
});

test("non-integer and non-finite numbers are refused rather than guessed at", () => {
  assert.throws(() => canonicalJson(1.5), SkillLockError);
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), SkillLockError);
  assert.throws(() => canonicalJson(Number.NaN), SkillLockError);
});

test("undefined properties are dropped so they cannot silently change a digest", () => {
  assert.equal(canonicalJson(toJson({ a: 1, b: undefined })), '{"a":1}');
});

test("unicode survives a canonical round trip", () => {
  const value = { "chave": "acentuação", emoji: "\u{1F9E0}" };
  assert.deepEqual(JSON.parse(canonicalJson(value)), value);
});

test("the same digest input produces the same digest", () => {
  const input = {
    kind: "clawhub" as const,
    coverage: "file-contents" as const,
    source: { slug: "x", version: "1.0.0" },
    content: { type: "files", entries: [{ path: "a", sha256: "aa" }] },
  };
  assert.equal(computeDigest(input), computeDigest(structuredClone(input)));
});

test("a digest changes when any covered field changes", () => {
  const base = {
    kind: "clawhub" as const,
    coverage: "file-contents" as const,
    source: { slug: "x", version: "1.0.0" },
    content: { type: "files", entries: [{ path: "a", sha256: "aa" }] },
  };
  const digest = computeDigest(base);
  assert.notEqual(digest, computeDigest({ ...base, source: { slug: "x", version: "1.0.1" } }));
  assert.notEqual(
    digest,
    computeDigest({ ...base, content: { type: "files", entries: [{ path: "a", sha256: "bb" }] } }),
  );
  assert.notEqual(digest, computeDigest({ ...base, coverage: "file-manifest" }));
});

test("digests are namespaced by coverage so a trusted hash cannot collide with a verified one", () => {
  const source = { slug: "x", version: "1.0.0" };
  const content = { type: "files", entries: [{ path: "a", sha256: "aa" }] };
  assert.notEqual(
    computeDigest({ kind: "clawhub", coverage: "file-contents", source, content }),
    computeDigest({ kind: "clawhub", coverage: "file-manifest", source, content }),
  );
});

test("sha256Of is prefixed and lowercase hex", () => {
  assert.match(sha256Of("hello"), /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    sha256Of("hello"),
    "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});
