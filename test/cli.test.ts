import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { emptyLockfile, serializeLockfile, upsertEntry } from "../src/lockfile.ts";
import type { LockEntry } from "../src/schema.ts";
import { entryFor } from "./helpers.ts";

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Only offline commands are exercised here: no test may depend on the network. */
async function cli(...args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const error = cause as { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "skill-lock-cli-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

async function writeLock(path: string, ...entries: LockEntry[]): Promise<void> {
  const lock = entries.reduce((acc, entry) => upsertEntry(acc, entry), emptyLockfile());
  await writeFile(path, serializeLockfile(lock), "utf8");
}

test("--help exits 0 and documents all four commands", async () => {
  const result = await cli("--help");
  assert.equal(result.code, 0);
  for (const command of ["add", "resolve", "verify", "diff"]) {
    assert.match(result.stdout, new RegExp(`skill-lock ${command}`));
  }
});

test("--version prints the package version", async () => {
  const result = await cli("--version");
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "0.1.0");
});

test("an unknown command exits 3 with a usable message", async () => {
  const result = await cli("frobnicate");
  assert.equal(result.code, 3);
  assert.match(result.stderr, /unknown command "frobnicate"/);
  assert.match(result.stderr, /--help/);
});

test("an unparseable ref exits 3 and never touches the network", async () => {
  const result = await cli("resolve", "npm:left-pad");
  assert.equal(result.code, 3);
  assert.match(result.stderr, /unrecognised reference/);
});

test("an unsupported git host is refused rather than attempted", async () => {
  const result = await cli("resolve", "gitlab.com/owner/repo");
  assert.equal(result.code, 3);
  assert.match(result.stderr, /unsupported git host/);
});

test("verify against a missing lockfile exits 3 with a hint", async () => {
  await withTempDir(async (dir) => {
    const result = await cli("verify", "--lockfile", join(dir, "absent.lock"));
    assert.equal(result.code, 3);
    assert.match(result.stderr, /no lockfile at/);
    assert.match(result.stderr, /skill-lock add/);
  });
});

test("a corrupt lockfile exits 3 instead of crashing", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "agents.lock");
    await writeFile(path, "{ this is not json", "utf8");
    const result = await cli("list", "--lockfile", path);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /not valid JSON/);
    assert.doesNotMatch(result.stderr, /at Object\./, "no raw stack trace");
  });
});

test("list prints locked entries with their digests", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "agents.lock");
    await writeLock(path, entryFor("prismfy-search"), entryFor("brave-search-mcp-server"));

    const result = await cli("list", "--lockfile", path);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /clawhub:uroboros1205\/prismfy-search@1\.3\.8/);
    assert.match(result.stdout, /mcp:io\.github\.brave\/brave-search-mcp-server@2\.1\.0/);
    assert.match(result.stdout, /sha256:[0-9a-f]{64}/);
  });
});

test("list --json emits the lockfile itself", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "agents.lock");
    await writeLock(path, entryFor("prismfy-search"));
    const result = await cli("list", "--lockfile", path, "--json");
    const parsed = JSON.parse(result.stdout) as { lockfile_version: number; entries: unknown[] };
    assert.equal(parsed.lockfile_version, 1);
    assert.equal(parsed.entries.length, 1);
  });
});

test("diff of two identical lockfiles exits 0 and reports no permission additions", async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, "a.lock");
    const b = join(dir, "b.lock");
    await writeLock(a, entryFor("prismfy-search"));
    await writeLock(b, entryFor("prismfy-search"));

    const result = await cli("diff", a, b);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /## Permission additions\n\nNone\./);
  });
});

test("diff exits 1 when an update demands new credentials", async () => {
  await withTempDir(async (dir) => {
    const before = join(dir, "before.lock");
    const after = join(dir, "after.lock");
    await writeLock(before, entryFor("openclaw-github-assistant@1.0.1"));
    await writeLock(after, entryFor("openclaw-github-assistant@1.0.2"));

    const result = await cli("diff", before, after);
    assert.equal(result.code, 1, "a permission addition must fail CI");
    assert.match(result.stdout, /## Permission additions \(4\)/);
    assert.match(result.stdout, /env:GITHUB_TOKEN/);
  });
});

test("diff --json produces a machine-readable report alongside the markdown one", async () => {
  await withTempDir(async (dir) => {
    const before = join(dir, "before.lock");
    const after = join(dir, "after.lock");
    await writeLock(before, entryFor("openclaw-github-assistant@1.0.1"));
    await writeLock(after, entryFor("openclaw-github-assistant@1.0.2"));

    const result = await cli("diff", before, after, "--json");
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout) as {
      schema: string;
      summary: { permission_additions: number };
    };
    assert.equal(report.schema, "skill-lock-diff-v1");
    assert.equal(report.summary.permission_additions, 4);
  });
});

test("diff with the wrong number of arguments exits 3", async () => {
  const result = await cli("diff");
  assert.equal(result.code, 3);
  assert.match(result.stderr, /two lockfile paths or one locked reference/);
});

test("diff of a ref absent from the lockfile exits 3 and lists what is locked", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "agents.lock");
    await writeLock(path, entryFor("prismfy-search"));
    const result = await cli("diff", "clawhub:someone/other@1.0.0", "--lockfile", path);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /is not in/);
    assert.match(result.stderr, /prismfy-search/);
  });
});

test("an unknown option is rejected rather than ignored", async () => {
  const result = await cli("list", "--turbo");
  assert.equal(result.code, 3);
  assert.match(result.stderr, /unknown option "--turbo"/);
});

test("generated output contains no em dashes", async () => {
  await withTempDir(async (dir) => {
    const before = join(dir, "before.lock");
    const after = join(dir, "after.lock");
    await writeLock(before, entryFor("openclaw-github-assistant@1.0.1"));
    await writeLock(after, entryFor("openclaw-github-assistant@1.0.2"));
    const result = await cli("diff", before, after);
    assert.doesNotMatch(result.stdout, /—/);
  });
});
