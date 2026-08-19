import assert from "node:assert/strict";
import test from "node:test";
import { emptyLockfile, upsertEntry } from "../src/lockfile.ts";
import { renderVerifyMarkdown } from "../src/report.ts";
import type { LockEntry } from "../src/schema.ts";
import { verifyExitCode, verifyLockfile } from "../src/verify.ts";
import { entryFor, offlineOptions } from "./helpers.ts";

const lockOf = (...entries: LockEntry[]) =>
  entries.reduce((lock, entry) => upsertEntry(lock, entry), emptyLockfile());

const MCP_VERSION =
  "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.brave%2Fbrave-search-mcp-server/versions/2.1.0";

test("a lockfile matching upstream verifies clean and exits 0", async () => {
  const lock = lockOf(entryFor("prismfy-search"), entryFor("brave-search-mcp-server"));
  const report = await verifyLockfile(lock, offlineOptions());

  assert.equal(report.summary.checked, 2);
  assert.equal(report.summary.ok, 2);
  assert.equal(report.summary.drift, 0);
  assert.equal(verifyExitCode(report, false), 0);
});

test("a pinned entry whose upstream content moved is drift and exits 1", async () => {
  const tampered = entryFor("prismfy-search");
  tampered.digest = `sha256:${"9".repeat(64)}`;

  const report = await verifyLockfile(lockOf(tampered), offlineOptions());
  assert.equal(report.summary.drift, 1);
  assert.equal(report.findings[0]!.status, "drift");
  assert.ok(report.findings[0]!.changes.some((c) => c.type === "pinned_digest_changed"));
  assert.equal(verifyExitCode(report, false), 1);
});

test("a permission change on a locked entry surfaces in verify", async () => {
  const stale = entryFor("brave-search-mcp-server");
  stale.permissions.secrets = [];

  const report = await verifyLockfile(lockOf(stale), offlineOptions());
  assert.equal(report.summary.drift, 1);
  assert.ok(
    report.findings[0]!.changes.some((c) => c.type === "permission_added" && c.to === "secret:BRAVE_API_KEY"),
  );
});

test("a locked ref that no longer exists upstream is drift, not a skip", async () => {
  const entry = entryFor("brave-search-mcp-server");
  const report = await verifyLockfile(
    lockOf(entry),
    offlineOptions({ [MCP_VERSION]: { status: 404, body: '{"title":"Not Found"}' } }),
  );

  assert.equal(report.findings[0]!.status, "drift");
  assert.equal(report.findings[0]!.error?.kind, "not-found");
  assert.equal(verifyExitCode(report, false), 1);
});

test("an unreachable upstream is an operational failure (exit 2), never a pass", async () => {
  const entry = entryFor("brave-search-mcp-server");
  const report = await verifyLockfile(lockOf(entry), offlineOptions({ [MCP_VERSION]: { status: 0 } }));

  assert.equal(report.findings[0]!.status, "error");
  assert.equal(report.summary.ok, 0);
  assert.equal(verifyExitCode(report, false), 2);
});

test("an unpinned ref that moved is an update, and only fails under --strict", async () => {
  const entry = entryFor("modelcontextprotocol/servers");
  assert.equal(entry.pinned, false);
  entry.digest = `sha256:${"5".repeat(64)}`;

  const report = await verifyLockfile(lockOf(entry), offlineOptions());
  assert.equal(report.findings[0]!.status, "update-available");
  assert.equal(verifyExitCode(report, false), 0);
  assert.equal(verifyExitCode(report, true), 1);
});

test("a source move is drift even for an unpinned ref", async () => {
  const entry = entryFor("modelcontextprotocol/servers");
  entry.resolved["owner"] = "someone-else";

  const report = await verifyLockfile(lockOf(entry), offlineOptions());
  assert.equal(report.findings[0]!.status, "drift");
});

test("drift outranks operational errors in the exit code", async () => {
  const drifted = entryFor("prismfy-search");
  drifted.digest = `sha256:${"9".repeat(64)}`;
  const report = await verifyLockfile(
    lockOf(drifted, entryFor("brave-search-mcp-server")),
    offlineOptions({ [MCP_VERSION]: { status: 0 } }),
  );

  assert.equal(report.summary.drift, 1);
  assert.equal(report.summary.errors, 1);
  assert.equal(verifyExitCode(report, false), 1);
});

test("the verify report states plainly when everything matched", async () => {
  const markdown = renderVerifyMarkdown(await verifyLockfile(lockOf(entryFor("prismfy-search")), offlineOptions()));
  assert.match(markdown, /re-resolved to the same source, digest and permissions/);
  assert.doesNotMatch(markdown, /—/);
});

test("an empty lockfile verifies clean without pretending to have checked anything", async () => {
  const report = await verifyLockfile(emptyLockfile(), offlineOptions());
  assert.equal(report.summary.checked, 0);
  assert.equal(verifyExitCode(report, true), 0);
});
