import assert from "node:assert/strict";
import test from "node:test";
import { diffEntries, diffLockfiles, permissionAdditions } from "../src/diff.ts";
import { emptyLockfile, upsertEntry } from "../src/lockfile.ts";
import { renderDiffMarkdown } from "../src/report.ts";
import type { LockEntry } from "../src/schema.ts";
import { entryFor } from "./helpers.ts";

const lockOf = (...entries: LockEntry[]) =>
  entries.reduce((lock, entry) => upsertEntry(lock, entry), emptyLockfile());

const findChange = (changes: ReturnType<typeof diffEntries>, type: string) =>
  changes.find((c) => c.type === type);

test("identical entries produce no changes", () => {
  const entry = entryFor("prismfy-search");
  assert.deepEqual(diffEntries(entry, structuredClone(entry)), []);
});

test("a new declared capability is reported as a high-severity permission addition", () => {
  const before = entryFor("prismfy-search");
  const after = structuredClone(before);
  after.permissions.secrets = [...before.permissions.secrets!, "env:NEW_TOKEN"];

  const changes = diffEntries(before, after);
  const added = findChange(changes, "permission_added");
  assert.ok(added);
  assert.equal(added.severity, "high");
  assert.equal(added.axis, "secrets");
  assert.equal(added.to, "env:NEW_TOKEN");
});

test("a removed capability is informational, not an alarm", () => {
  const before = entryFor("prismfy-search");
  const after = structuredClone(before);
  after.permissions.exec = ["bin:curl"];

  const removed = findChange(diffEntries(before, after), "permission_removed");
  assert.ok(removed);
  assert.equal(removed.severity, "info");
  assert.equal(removed.from, "bin:jq");
});

test("an axis that stops being declared is flagged: unknown is not the same as none", () => {
  const before = entryFor("prismfy-search");
  const after = structuredClone(before);
  after.permissions.secrets = null;

  const change = findChange(diffEntries(before, after), "permission_no_longer_declared");
  assert.ok(change);
  assert.equal(change.severity, "medium");
});

test("a publisher change under a locked ref is a high-severity source move", () => {
  const before = entryFor("prismfy-search");
  const after = structuredClone(before);
  after.resolved["owner"] = "someone-else";

  const moved = findChange(diffEntries(before, after), "source_moved");
  assert.ok(moved);
  assert.equal(moved.severity, "high");
  assert.equal(moved.field, "owner");
});

test("a pinned version whose content changed is called out as republishing", () => {
  const before = entryFor("prismfy-search");
  const after = structuredClone(before);
  after.digest = `sha256:${"1".repeat(64)}`;

  const change = findChange(diffEntries(before, after), "pinned_digest_changed");
  assert.ok(change);
  assert.equal(change.severity, "high");
  assert.match(change.note ?? "", /republished/);
});

test("a digest change that comes with a version change is an ordinary update", () => {
  const before = entryFor("elite-longterm-memory@0.1.0");
  const after = entryFor("elite-longterm-memory@1.2.3");
  const changes = diffEntries(before, after);

  assert.equal(findChange(changes, "pinned_digest_changed"), undefined);
  const digest = findChange(changes, "digest_changed");
  assert.ok(digest);
  assert.equal(digest.severity, "medium");
});

test("the real 0.1.0 to 1.2.3 upgrade shows a manifest key rename with no permission change", () => {
  const before = entryFor("elite-longterm-memory@0.1.0");
  const after = entryFor("elite-longterm-memory@1.2.3");
  const changes = diffEntries(before, after);

  assert.equal(
    changes.filter((c) => c.type === "permission_added").length,
    0,
    "the declared secret is identical; only the metadata key was renamed",
  );
  assert.ok(changes.some((c) => c.type === "manifest_field_changed" || c.type === "manifest_field_added"));
});

test("added and removed entries are distinguished from changed ones", () => {
  const a = lockOf(entryFor("prismfy-search"));
  const b = lockOf(entryFor("brave-search-mcp-server"));
  const report = diffLockfiles(a, b, { from: "a", to: "b" });

  assert.equal(report.summary.added, 1);
  assert.equal(report.summary.removed, 1);
  assert.equal(report.summary.changed, 0);
});

test("the summary counts permission additions and high-severity changes", () => {
  const before = entryFor("prismfy-search");
  const after = structuredClone(before);
  after.permissions.secrets = [...before.permissions.secrets!, "env:NEW_TOKEN"];
  after.permissions.network = ["url:https://exfil.example.com"];

  const report = diffLockfiles(lockOf(before), lockOf(after), { from: "a", to: "b" });
  assert.equal(report.summary.permission_additions, 2);
  assert.ok(report.summary.high_severity >= 2);
  assert.equal(permissionAdditions(report).length, 2);
});

test("high-severity changes sort ahead of informational ones", () => {
  const before = entryFor("prismfy-search");
  const after = structuredClone(before);
  after.permissions.exec = ["bin:curl", "bin:newtool"];
  const report = diffLockfiles(lockOf(before), lockOf(after), { from: "a", to: "b" });
  const severities = report.entries[0]!.changes.map((c) => c.severity);
  assert.deepEqual(severities, [...severities].sort((x, y) => (x === "high" ? -1 : y === "high" ? 1 : 0)));
});

test("the markdown report leads with permission additions", () => {
  const before = entryFor("prismfy-search");
  const after = structuredClone(before);
  after.permissions.secrets = [...before.permissions.secrets!, "env:NEW_TOKEN"];

  const markdown = renderDiffMarkdown(diffLockfiles(lockOf(before), lockOf(after), { from: "a", to: "b" }));
  const additionsIndex = markdown.indexOf("## Permission additions");
  const summaryIndex = markdown.indexOf("## Summary");

  assert.ok(additionsIndex >= 0 && additionsIndex < summaryIndex);
  assert.match(markdown, /env:NEW_TOKEN/);
  assert.doesNotMatch(markdown, /—/, "no em dashes in generated prose");
});

test("a clean diff says so explicitly", () => {
  const entry = entryFor("prismfy-search");
  const markdown = renderDiffMarkdown(
    diffLockfiles(lockOf(entry), lockOf(structuredClone(entry)), { from: "a", to: "b" }),
  );
  assert.match(markdown, /## Permission additions\n\nNone\./);
});

test("the real GitHub-assistant 1.0.1 to 1.0.2 upgrade is reported as a credential demand", () => {
  const before = entryFor("openclaw-github-assistant@1.0.1");
  const after = entryFor("openclaw-github-assistant@1.0.2");
  const report = diffLockfiles(lockOf(before), lockOf(after), { from: "before", to: "after" });

  assert.equal(report.entries.length, 1, "a version bump is one changed extension, not an add plus a remove");
  assert.equal(report.entries[0]!.status, "changed");
  assert.equal(report.entries[0]!.from_ref, before.ref);
  assert.equal(report.summary.permission_additions, 4);

  const added = permissionAdditions(report).map((p) => p.change.to);
  assert.deepEqual(added, [
    "config:github.token",
    "config:github.username",
    "env:GITHUB_TOKEN",
    "env:GITHUB_USERNAME",
  ]);
});

test("prose is never mistaken for a declaration", () => {
  const before = entryFor("openclaw-github-assistant@1.0.1");
  assert.equal(
    before.permissions.status,
    "undeclared",
    "1.0.1 tells the reader to set GITHUB_TOKEN in its body but declares nothing in its manifest",
  );
  assert.equal(before.permissions.manifest, "SKILL.md", "we did read the manifest");
});

test("two versions of one extension pair by identity, not by ref string", () => {
  const before = entryFor("elite-longterm-memory@0.1.0");
  const after = entryFor("elite-longterm-memory@1.2.3");
  const report = diffLockfiles(lockOf(before), lockOf(after), { from: "a", to: "b" });

  assert.equal(report.summary.added, 0);
  assert.equal(report.summary.removed, 0);
  assert.equal(report.summary.changed, 1);
});
