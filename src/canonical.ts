import { createHash } from "node:crypto";
import { SkillLockError } from "./errors.ts";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * Deterministic JSON serialisation: object keys sorted by UTF-16 code unit,
 * no insignificant whitespace, arrays keep their (already-sorted) order.
 *
 * This is the RFC 8785 (JCS) subset that skill-lock's inputs actually need.
 * Non-integer and non-finite numbers are rejected rather than serialised,
 * because their canonical form is where JCS implementations disagree and a
 * digest that depends on float formatting is not a digest anyone can verify.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SkillLockError("integrity", `cannot canonicalise non-finite number: ${String(value)}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new SkillLockError(
        "integrity",
        `cannot canonicalise non-integer number: ${String(value)}`,
        { hint: "Convert fractional or out-of-range numbers to strings before digesting them." },
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const child = value[key];
    if (child === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(child)}`);
  }
  return `{${parts.join(",")}}`;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Of(data: Uint8Array | string): string {
  return `sha256:${sha256Hex(data)}`;
}

/** Strip undefined recursively so a value is safe to canonicalise. */
export function toJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toJson(v);
    }
    return out;
  }
  throw new SkillLockError("integrity", `value of type ${typeof value} cannot appear in a digest input`);
}

export const DIGEST_ALGORITHM = "skill-lock-digest-v1";

/** What the content digest actually covers. Recorded in the lockfile so a reader never has to guess. */
export type DigestCoverage =
  /** every file's bytes were downloaded and hashed by skill-lock */
  | "file-contents"
  /** the registry's per-file hashes, taken on trust because content fetching was disabled */
  | "file-manifest"
  /** the git tree listing: paths, modes, and git blob object ids (hashed by GitHub, not by us) */
  | "git-tree"
  /** the registry's immutable version record, with registry-side timestamps removed */
  | "registry-record";

export interface DigestInput {
  kind: string;
  coverage: DigestCoverage;
  source: JsonValue;
  content: JsonValue;
}

export function computeDigest(input: DigestInput): string {
  const envelope: JsonValue = {
    algorithm: DIGEST_ALGORITHM,
    content: input.content,
    coverage: input.coverage,
    kind: input.kind,
    source: input.source,
  };
  return sha256Of(canonicalJson(envelope));
}
