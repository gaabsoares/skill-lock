import { readFile, writeFile } from "node:fs/promises";
import { lockfileError } from "./errors.ts";
import { AXES } from "./permissions.ts";
import {
  LOCKFILE_VERSION,
  LockfileSchema,
  SIDECAR_VERSION,
  SidecarSchema,
  type LockEntry,
  type Lockfile,
  type Sidecar,
} from "./schema.ts";

export const DEFAULT_LOCKFILE = "agents.lock";
export const sidecarPathFor = (lockfilePath: string) => `${lockfilePath}.meta.json`;

export const GENERATOR = "skill-lock";
export const GENERATOR_VERSION = "0.1.0";

/** Key order inside a lock entry. Fixed for readability and byte-stability. */
const ENTRY_KEYS = [
  "ref",
  "kind",
  "pinned",
  "resolved",
  "digest",
  "digest_covers",
  "permissions",
  "manifest_fields",
  "warnings",
] as const;

function orderedRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key]!;
  return out;
}

function orderedEntry(entry: LockEntry): Record<string, unknown> {
  const permissions: Record<string, unknown> = {
    status: entry.permissions.status,
    manifest: entry.permissions.manifest,
  };
  for (const axis of AXES) permissions[axis] = entry.permissions[axis];

  const shaped: Record<string, unknown> = {
    ref: entry.ref,
    kind: entry.kind,
    pinned: entry.pinned,
    resolved: orderedRecord(entry.resolved),
    digest: entry.digest,
    digest_covers: entry.digest_covers,
    permissions,
    manifest_fields: orderedRecord(entry.manifest_fields),
  };
  if (entry.warnings !== undefined && entry.warnings.length > 0) {
    shaped["warnings"] = [...new Set(entry.warnings)];
  }

  const out: Record<string, unknown> = {};
  for (const key of ENTRY_KEYS) {
    if (key in shaped) out[key] = shaped[key];
  }
  return out;
}

export function sortEntries(entries: LockEntry[]): LockEntry[] {
  return [...entries].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/**
 * Byte-stable rendering: entries sorted by ref, fixed key order at every level,
 * and no timestamps anywhere. Two runs against unchanged upstreams produce
 * identical bytes, which is what makes `git diff` on this file mean something.
 */
export function serializeLockfile(lock: Lockfile): string {
  const shaped = {
    lockfile_version: lock.lockfile_version,
    generator: lock.generator,
    entries: sortEntries(lock.entries).map(orderedEntry),
  };
  return `${JSON.stringify(shaped, null, 2)}\n`;
}

export function emptyLockfile(): Lockfile {
  return { lockfile_version: LOCKFILE_VERSION, generator: GENERATOR, entries: [] };
}

export function parseLockfile(text: string, path: string): Lockfile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw lockfileError(`${path} is not valid JSON: ${(cause as Error).message}`);
  }
  const result = LockfileSchema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    throw lockfileError(
      `${path} is not a valid skill-lock lockfile: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`.trim(),
    );
  }
  if (result.data.lockfile_version !== LOCKFILE_VERSION) {
    throw lockfileError(
      `${path} declares lockfile_version ${result.data.lockfile_version}; this build of skill-lock writes version ${LOCKFILE_VERSION}`,
      "Regenerate the lockfile with a matching skill-lock version rather than editing it by hand.",
    );
  }
  return result.data;
}

export async function readLockfile(path: string): Promise<Lockfile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw lockfileError(`no lockfile at ${path}`, "Create one with `skill-lock add <ref>`.");
    }
    throw lockfileError(`cannot read ${path}: ${(cause as Error).message}`);
  }
  return parseLockfile(text, path);
}

export async function writeLockfile(path: string, lock: Lockfile): Promise<void> {
  await writeFile(path, serializeLockfile(lock), "utf8");
}

export function upsertEntry(lock: Lockfile, entry: LockEntry): Lockfile {
  const entries = lock.entries.filter((e) => e.ref !== entry.ref);
  entries.push(entry);
  return { ...lock, entries: sortEntries(entries) };
}

export function findEntry(lock: Lockfile, ref: string): LockEntry | undefined {
  return lock.entries.find((e) => e.ref === ref);
}

/* ------------------------------------------------------------------ */
/* Sidecar: everything that would otherwise churn the lockfile          */
/* ------------------------------------------------------------------ */

export function emptySidecar(): Sidecar {
  return {
    sidecar_version: SIDECAR_VERSION,
    generator: GENERATOR,
    generator_version: GENERATOR_VERSION,
    resolutions: {},
  };
}

export async function readSidecar(path: string): Promise<Sidecar> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return emptySidecar();
  }
  const result = SidecarSchema.safeParse(JSON.parse(text));
  return result.success ? result.data : emptySidecar();
}

export function serializeSidecar(sidecar: Sidecar): string {
  return `${JSON.stringify(
    {
      sidecar_version: sidecar.sidecar_version,
      generator: sidecar.generator,
      generator_version: sidecar.generator_version,
      resolutions: orderedRecord(sidecar.resolutions),
    },
    null,
    2,
  )}\n`;
}

export async function writeSidecar(path: string, sidecar: Sidecar): Promise<void> {
  await writeFile(path, serializeSidecar(sidecar), "utf8");
}

/** Prune sidecar rows whose ref is no longer locked, so it cannot grow forever. */
export function syncSidecar(sidecar: Sidecar, lock: Lockfile, touched: Map<string, string>): Sidecar {
  const refs = new Set(lock.entries.map((e) => e.ref));
  const resolutions: Record<string, { resolved_at: string }> = {};
  for (const [ref, at] of Object.entries(sidecar.resolutions)) {
    if (refs.has(ref)) resolutions[ref] = at;
  }
  for (const [ref, at] of touched) {
    if (refs.has(ref)) resolutions[ref] = { resolved_at: at };
  }
  return { ...sidecar, generator_version: GENERATOR_VERSION, resolutions };
}
