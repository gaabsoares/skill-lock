import { AXES, type Axis } from "./permissions.ts";
import type { RefKind } from "./ref.ts";
import type { LockEntry, Lockfile } from "./schema.ts";

export type Severity = "high" | "medium" | "info";

export type ChangeType =
  | "kind_changed"
  | "source_moved"
  | "version_changed"
  | "digest_changed"
  | "pinned_digest_changed"
  | "permission_added"
  | "permission_removed"
  | "permission_now_declared"
  | "permission_no_longer_declared"
  | "manifest_field_changed"
  | "manifest_field_added"
  | "manifest_field_removed";

export type Scalar = string | number | boolean | null;

export interface Change {
  type: ChangeType;
  severity: Severity;
  axis?: Axis;
  field?: string;
  from: Scalar;
  to: Scalar;
  note?: string;
}

export interface EntryDiff {
  ref: string;
  /** set when the same extension is locked under a different ref on each side, i.e. a version bump */
  from_ref?: string;
  kind: RefKind;
  status: "added" | "removed" | "changed" | "unchanged";
  changes: Change[];
}

/**
 * What makes two lock entries the same extension, independent of version.
 *
 * Diffing by raw ref would make `foo@1.0.0` and `foo@1.0.1` look like one
 * extension being removed and an unrelated one added, which hides exactly the
 * permission delta the diff exists to show.
 */
export function identityKey(entry: LockEntry): string {
  const r = entry.resolved;
  switch (entry.kind) {
    case "clawhub":
      return `clawhub:${r["registry"] ?? ""}/${r["owner"] ?? ""}/${r["slug"] ?? ""}`;
    case "mcp":
      return `mcp:${r["registry"] ?? ""}/${r["name"] ?? ""}`;
    case "git":
      return `git:${r["host"] ?? ""}/${r["owner"] ?? ""}/${r["repo"] ?? ""}#${r["subdir"] ?? ""}`;
  }
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  permission_additions: number;
  high_severity: number;
}

export interface DiffReport {
  schema: "skill-lock-diff-v1";
  from: string;
  to: string;
  summary: DiffSummary;
  entries: EntryDiff[];
}

/**
 * Fields whose change means the extension is no longer coming from the same
 * place. A version bump is routine; the publisher changing underneath a locked
 * name is not, so the two are never folded into one "source changed" line.
 */
const IDENTITY_FIELDS: Record<RefKind, readonly string[]> = {
  clawhub: ["registry", "owner", "slug"],
  mcp: ["registry", "name"],
  git: ["host", "owner", "repo", "subdir"],
};

function compareResolved(a: LockEntry, b: LockEntry): Change[] {
  const changes: Change[] = [];
  const identity = new Set(IDENTITY_FIELDS[b.kind] ?? []);
  const keys = [...new Set([...Object.keys(a.resolved), ...Object.keys(b.resolved)])].sort();

  for (const key of keys) {
    const from = a.resolved[key] ?? null;
    const to = b.resolved[key] ?? null;
    if (from === to) continue;
    if (identity.has(key)) {
      changes.push({
        type: "source_moved",
        severity: "high",
        field: key,
        from,
        to,
        note: "the locked ref now points at a different publisher or repository",
      });
    } else if (key === "version" || key === "commit") {
      changes.push({ type: "version_changed", severity: "medium", field: key, from, to });
    }
  }
  return changes;
}

function comparePermissions(a: LockEntry, b: LockEntry): Change[] {
  const changes: Change[] = [];

  for (const axis of AXES) {
    const from = a.permissions[axis];
    const to = b.permissions[axis];

    if (from === null && to !== null) {
      changes.push({
        type: "permission_now_declared",
        severity: "info",
        axis,
        from: null,
        to: `${to.length} declared`,
        note: "this axis had no declaration before",
      });
    } else if (from !== null && to === null) {
      changes.push({
        type: "permission_no_longer_declared",
        severity: "medium",
        axis,
        from: `${from.length} declared`,
        to: null,
        note: "the manifest stopped declaring this axis; capability is now unknown, not absent",
      });
    }

    const before = new Set(from ?? []);
    const after = new Set(to ?? []);
    for (const value of [...after].filter((v) => !before.has(v)).sort()) {
      changes.push({ type: "permission_added", severity: "high", axis, from: null, to: value });
    }
    for (const value of [...before].filter((v) => !after.has(v)).sort()) {
      changes.push({ type: "permission_removed", severity: "info", axis, from: value, to: null });
    }
  }
  return changes;
}

function compareManifestFields(a: LockEntry, b: LockEntry): Change[] {
  const changes: Change[] = [];
  const keys = [...new Set([...Object.keys(a.manifest_fields), ...Object.keys(b.manifest_fields)])].sort();
  for (const key of keys) {
    const inA = key in a.manifest_fields;
    const inB = key in b.manifest_fields;
    const from = a.manifest_fields[key] ?? null;
    const to = b.manifest_fields[key] ?? null;
    if (inA && !inB) {
      changes.push({ type: "manifest_field_removed", severity: "info", field: key, from, to: null });
    } else if (!inA && inB) {
      changes.push({ type: "manifest_field_added", severity: "info", field: key, from: null, to });
    } else if (from !== to) {
      changes.push({ type: "manifest_field_changed", severity: "medium", field: key, from, to });
    }
  }
  return changes;
}

export function diffEntries(a: LockEntry, b: LockEntry): Change[] {
  const changes: Change[] = [];

  if (a.kind !== b.kind) {
    changes.push({ type: "kind_changed", severity: "high", from: a.kind, to: b.kind });
  }

  changes.push(...compareResolved(a, b));

  if (a.digest !== b.digest) {
    // an immutable coordinate whose bytes moved is republishing under a fixed
    // name, which is the exact event a lockfile exists to catch
    const republished = a.pinned && b.pinned && a.ref === b.ref && sameCoordinates(a, b);
    changes.push(
      republished
        ? {
            type: "pinned_digest_changed",
            severity: "high",
            from: a.digest,
            to: b.digest,
            note: "a pinned version changed content: the publisher republished under the same immutable coordinate",
          }
        : { type: "digest_changed", severity: "medium", from: a.digest, to: b.digest },
    );
  }

  changes.push(...comparePermissions(a, b));
  changes.push(...compareManifestFields(a, b));
  return changes;
}

function sameCoordinates(a: LockEntry, b: LockEntry): boolean {
  const keys = a.kind === "git" ? ["commit"] : ["version"];
  return keys.every((k) => (a.resolved[k] ?? null) === (b.resolved[k] ?? null));
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, info: 2 };

export function diffLockfiles(
  a: Lockfile,
  b: Lockfile,
  labels: { from: string; to: string },
): DiffReport {
  const byIdA = new Map(a.entries.map((e) => [identityKey(e), e]));
  const byIdB = new Map(b.entries.map((e) => [identityKey(e), e]));
  const ids = [...new Set([...byIdA.keys(), ...byIdB.keys()])].sort();

  const entries: EntryDiff[] = [];
  for (const id of ids) {
    const before = byIdA.get(id);
    const after = byIdB.get(id);

    if (before === undefined && after !== undefined) {
      entries.push({ ref: after.ref, kind: after.kind, status: "added", changes: [] });
      continue;
    }
    if (before !== undefined && after === undefined) {
      entries.push({ ref: before.ref, kind: before.kind, status: "removed", changes: [] });
      continue;
    }
    const changes = diffEntries(before!, after!).sort(
      (x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity],
    );
    entries.push({
      ref: after!.ref,
      ...(before!.ref === after!.ref ? {} : { from_ref: before!.ref }),
      kind: after!.kind,
      status: changes.length === 0 && before!.ref === after!.ref ? "unchanged" : "changed",
      changes,
    });
  }

  const summary: DiffSummary = {
    added: entries.filter((e) => e.status === "added").length,
    removed: entries.filter((e) => e.status === "removed").length,
    changed: entries.filter((e) => e.status === "changed").length,
    unchanged: entries.filter((e) => e.status === "unchanged").length,
    permission_additions: entries.reduce(
      (n, e) => n + e.changes.filter((c) => c.type === "permission_added").length,
      0,
    ),
    high_severity: entries.reduce((n, e) => n + e.changes.filter((c) => c.severity === "high").length, 0),
  };

  return { schema: "skill-lock-diff-v1", from: labels.from, to: labels.to, summary, entries };
}

export function permissionAdditions(report: DiffReport): { ref: string; change: Change }[] {
  return report.entries.flatMap((entry) =>
    entry.changes.filter((c) => c.type === "permission_added").map((change) => ({ ref: entry.ref, change })),
  );
}
