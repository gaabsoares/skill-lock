import { permissionAdditions, type Change, type DiffReport, type EntryDiff } from "./diff.ts";
import { AXES } from "./permissions.ts";
import type { LockEntry } from "./schema.ts";
import type { VerifyReport } from "./verify.ts";

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const show = (value: string | number | boolean | null): string =>
  value === null ? "(none)" : typeof value === "string" ? value : String(value);

const code = (value: string | number | boolean | null): string =>
  value === null ? "(none)" : `\`${String(value)}\``;

function describeChange(change: Change): string {
  const where = change.axis !== undefined ? `${change.axis}` : (change.field ?? "");
  switch (change.type) {
    case "permission_added":
      return `**permission added** (${where}): ${code(change.to)}`;
    case "permission_removed":
      return `permission removed (${where}): ${code(change.from)}`;
    case "permission_now_declared":
      return `${where} is now declared (was undeclared)`;
    case "permission_no_longer_declared":
      return `**${where} is no longer declared**: capability is now unknown, not absent`;
    case "pinned_digest_changed":
      return `**pinned content changed**: ${code(change.from)} to ${code(change.to)}`;
    case "digest_changed":
      return `digest changed: ${code(change.from)} to ${code(change.to)}`;
    case "source_moved":
      return `**source moved** (${where}): ${code(change.from)} to ${code(change.to)}`;
    case "version_changed":
      return `${where}: ${code(change.from)} to ${code(change.to)}`;
    case "kind_changed":
      return `**extension kind changed**: ${code(change.from)} to ${code(change.to)}`;
    case "manifest_field_changed":
      return `manifest field \`${where}\`: ${code(change.from)} to ${code(change.to)}`;
    case "manifest_field_added":
      return `manifest field \`${where}\` added: ${code(change.to)}`;
    case "manifest_field_removed":
      return `manifest field \`${where}\` removed (was ${code(change.from)})`;
  }
}

function renderEntryChanges(entry: EntryDiff): string[] {
  const heading = entry.from_ref === undefined ? entry.ref : `${entry.from_ref} to ${entry.ref}`;
  const lines: string[] = [`### ${heading}`, "", `Status: ${entry.status} (${entry.kind})`, ""];
  if (entry.changes.length === 0) {
    lines.push(entry.status === "added" ? "New entry." : entry.status === "removed" ? "Entry removed." : "No changes.", "");
    return lines;
  }
  for (const change of entry.changes) {
    lines.push(`- [${change.severity}] ${describeChange(change)}`);
    if (change.note !== undefined) lines.push(`  - ${change.note}`);
  }
  lines.push("");
  return lines;
}

export function renderDiffMarkdown(report: DiffReport): string {
  const additions = permissionAdditions(report);
  const lines: string[] = [
    "# skill-lock diff",
    "",
    `Comparing \`${report.from}\` to \`${report.to}\`.`,
    "",
  ];

  if (additions.length > 0) {
    lines.push(
      `## Permission additions (${additions.length})`,
      "",
      "New capability an extension did not previously declare. Review before accepting the update.",
      "",
      "| Extension | Axis | Added |",
      "| --- | --- | --- |",
    );
    for (const { ref, change } of additions) {
      lines.push(`| \`${ref}\` | ${change.axis ?? ""} | \`${show(change.to)}\` |`);
    }
    lines.push("");
  } else {
    lines.push("## Permission additions", "", "None.", "");
  }

  const s = report.summary;
  lines.push(
    "## Summary",
    "",
    `- entries added: ${s.added}`,
    `- entries removed: ${s.removed}`,
    `- entries changed: ${s.changed}`,
    `- entries unchanged: ${s.unchanged}`,
    `- permission additions: ${s.permission_additions}`,
    `- high severity changes: ${s.high_severity}`,
    "",
  );

  const interesting = report.entries.filter((e) => e.status !== "unchanged");
  if (interesting.length > 0) {
    lines.push("## Changes by extension", "");
    for (const entry of interesting) lines.push(...renderEntryChanges(entry));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderVerifyMarkdown(report: VerifyReport): string {
  const s = report.summary;
  const lines: string[] = [
    "# skill-lock verify",
    "",
    `Checked ${s.checked} locked ${s.checked === 1 ? "entry" : "entries"}: ${s.ok} matching, ${s.drift} drifted, ${s.updates} with updates available, ${s.errors} not checkable.`,
    "",
  ];

  const bucket = (status: string, heading: string, blurb: string) => {
    const rows = report.findings.filter((f) => f.status === status);
    if (rows.length === 0) return;
    lines.push(`## ${heading} (${rows.length})`, "", blurb, "");
    for (const finding of rows) {
      lines.push(`### ${finding.ref}`, "", finding.reason + ".", "");
      if (finding.error !== undefined) {
        lines.push(`- error kind: \`${finding.error.kind}\``, `- ${finding.error.message}`, "");
      }
      for (const change of finding.changes) {
        lines.push(`- [${change.severity}] ${describeChange(change)}`);
      }
      if (finding.changes.length > 0) lines.push("");
    }
  };

  bucket("drift", "Drift", "The locked entry and the upstream artifact no longer agree.");
  bucket("error", "Not checkable", "These could not be re-resolved. This is an operational failure, not a clean result.");
  bucket("update-available", "Updates available", "Unpinned refs that moved upstream. Review, then re-add to accept.");

  if (s.drift === 0 && s.errors === 0 && s.updates === 0) {
    lines.push("Every locked entry re-resolved to the same source, digest and permissions.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderEntryMarkdown(entry: LockEntry): string {
  const lines: string[] = [
    `# ${entry.ref}`,
    "",
    `- kind: ${entry.kind}`,
    `- pinned: ${entry.pinned ? "yes" : "no (tracks a moving target)"}`,
    `- digest: \`${entry.digest}\``,
    `- digest covers: ${entry.digest_covers}`,
    "",
    "## Resolved source",
    "",
  ];
  for (const key of Object.keys(entry.resolved).sort()) {
    lines.push(`- ${key}: ${code(entry.resolved[key] ?? null)}`);
  }

  lines.push("", "## Declared permissions", "");
  if (entry.permissions.status === "undeclared") {
    lines.push(
      entry.permissions.manifest === null
        ? "Undeclared: no manifest was found, so nothing is known about what this extension can do."
        : `Undeclared: \`${entry.permissions.manifest}\` was read and declares no permissions.`,
      "",
      "Undeclared is not the same as none. skill-lock does not guess capability from code or prose.",
      "",
    );
  } else {
    lines.push(`Read from \`${entry.permissions.manifest ?? "unknown"}\`.`, "");
    for (const axis of AXES) {
      const values = entry.permissions[axis];
      if (values === null) {
        lines.push(`- ${axis}: undeclared`);
      } else if (values.length === 0) {
        lines.push(`- ${axis}: declared, none`);
      } else {
        lines.push(`- ${axis}:`);
        for (const value of values) lines.push(`  - \`${value}\``);
      }
    }
    lines.push("");
  }

  if (entry.warnings !== undefined && entry.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of entry.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderEntryLine(entry: LockEntry): string {
  const perms = AXES.map((axis) => {
    const values = entry.permissions[axis];
    return `${axis}=${values === null ? "undeclared" : values.length}`;
  }).join(" ");
  return `${entry.ref}\n  digest   ${entry.digest} (${entry.digest_covers})\n  pinned   ${entry.pinned ? "yes" : "no"}\n  perms    ${perms}`;
}
