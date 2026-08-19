import { diffEntries, type Change } from "./diff.ts";
import { SkillLockError, type ErrorKind } from "./errors.ts";
import { parseRef } from "./ref.ts";
import { resolveParsed, type ResolveOptions } from "./resolvers/index.ts";
import type { LockEntry, Lockfile } from "./schema.ts";

export type VerifyStatus = "ok" | "drift" | "update-available" | "error";

export interface VerifyFinding {
  ref: string;
  status: VerifyStatus;
  reason: string;
  changes: Change[];
  error?: { kind: ErrorKind; message: string };
}

export interface VerifyReport {
  schema: "skill-lock-verify-v1";
  summary: { checked: number; ok: number; drift: number; updates: number; errors: number };
  findings: VerifyFinding[];
}

/**
 * Re-resolve each locked ref and classify what came back.
 *
 * The pinned/unpinned split carries the whole judgement. A pinned ref that
 * resolves differently is drift: the artifact behind an immutable coordinate
 * moved. An unpinned ref that resolves differently is just an update, unless
 * the publisher or repository changed underneath it, which is drift either way.
 */
export async function verifyLockfile(
  lock: Lockfile,
  options: ResolveOptions,
): Promise<VerifyReport> {
  const findings: VerifyFinding[] = [];

  for (const entry of lock.entries) {
    findings.push(await verifyEntry(entry, options));
  }

  return {
    schema: "skill-lock-verify-v1",
    summary: {
      checked: findings.length,
      ok: findings.filter((f) => f.status === "ok").length,
      drift: findings.filter((f) => f.status === "drift").length,
      updates: findings.filter((f) => f.status === "update-available").length,
      errors: findings.filter((f) => f.status === "error").length,
    },
    findings,
  };
}

export async function verifyEntry(entry: LockEntry, options: ResolveOptions): Promise<VerifyFinding> {
  let fresh: LockEntry;
  try {
    fresh = await resolveParsed(parseRef(entry.ref), options);
  } catch (cause) {
    if (cause instanceof SkillLockError) {
      const gone = cause.kind === "not-found" || cause.kind === "ambiguous-ref";
      return {
        ref: entry.ref,
        status: gone ? "drift" : "error",
        reason: gone
          ? "locked ref no longer resolves upstream"
          : "could not be checked",
        changes: [],
        error: { kind: cause.kind, message: cause.message },
      };
    }
    throw cause;
  }

  const changes = diffEntries(entry, fresh);
  if (changes.length === 0) {
    return { ref: entry.ref, status: "ok", reason: "matches the lockfile", changes: [] };
  }

  const moved = changes.some((c) => c.type === "source_moved" || c.type === "kind_changed");
  if (entry.pinned || moved) {
    return {
      ref: entry.ref,
      status: "drift",
      reason: moved
        ? "the ref now resolves to a different source"
        : "a pinned ref resolved to different content",
      changes,
    };
  }
  return {
    ref: entry.ref,
    status: "update-available",
    reason: "unpinned ref moved upstream",
    changes,
  };
}

export function verifyExitCode(report: VerifyReport, strict: boolean): number {
  if (report.summary.drift > 0) return 1;
  if (report.summary.errors > 0) return 2;
  if (strict && report.summary.updates > 0) return 1;
  return 0;
}
