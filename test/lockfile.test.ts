import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillLockError } from "../src/errors.ts";
import {
  emptyLockfile,
  emptySidecar,
  parseLockfile,
  readLockfile,
  serializeLockfile,
  serializeSidecar,
  syncSidecar,
  upsertEntry,
  writeLockfile,
} from "../src/lockfile.ts";
import type { Lockfile } from "../src/schema.ts";
import { entryFor, expected } from "./helpers.ts";

function fullLockfile(): Lockfile {
  return expected.entries.reduce((lock, entry) => upsertEntry(lock, entry), emptyLockfile());
}

const withTempDir = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "skill-lock-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("serialising the same lockfile twice yields identical bytes", () => {
  const lock = fullLockfile();
  assert.equal(serializeLockfile(lock), serializeLockfile(structuredClone(lock)));
});

test("entry insertion order does not affect the serialised bytes", () => {
  const forward = expected.entries.reduce((lock, e) => upsertEntry(lock, e), emptyLockfile());
  const backward = [...expected.entries]
    .reverse()
    .reduce((lock, e) => upsertEntry(lock, e), emptyLockfile());
  assert.equal(serializeLockfile(forward), serializeLockfile(backward));
});

test("key insertion order inside an entry does not affect the serialised bytes", () => {
  const entry = entryFor("prismfy-search");
  const shuffled = structuredClone(entry);
  shuffled.resolved = Object.fromEntries(Object.entries(entry.resolved).reverse());
  shuffled.manifest_fields = Object.fromEntries(Object.entries(entry.manifest_fields).reverse());

  assert.equal(
    serializeLockfile({ ...emptyLockfile(), entries: [entry] }),
    serializeLockfile({ ...emptyLockfile(), entries: [shuffled] }),
  );
});

test("the lockfile contains no timestamp anywhere", () => {
  const text = serializeLockfile(fullLockfile());
  assert.doesNotMatch(text, /resolved_at/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
});

test("a lockfile round-trips through parse without losing anything", () => {
  const lock = fullLockfile();
  const text = serializeLockfile(lock);
  assert.equal(serializeLockfile(parseLockfile(text, "agents.lock")), text);
});

test("upsert replaces an existing ref rather than duplicating it", () => {
  const entry = entryFor("prismfy-search");
  let lock = upsertEntry(emptyLockfile(), entry);
  lock = upsertEntry(lock, { ...entry, digest: `sha256:${"0".repeat(64)}` });
  assert.equal(lock.entries.length, 1);
  assert.equal(lock.entries[0]!.digest, `sha256:${"0".repeat(64)}`);
});

test("entries are sorted by ref so a diff is stable", () => {
  const lock = fullLockfile();
  const refs = lock.entries.map((e) => e.ref);
  assert.deepEqual(refs, [...refs].sort());
});

test("a malformed lockfile is rejected with a lockfile error, not a stack trace", () => {
  assert.throws(() => parseLockfile("{ not json", "agents.lock"), (error: unknown) => {
    assert.ok(error instanceof SkillLockError);
    assert.equal(error.kind, "lockfile");
    return true;
  });
  assert.throws(() => parseLockfile('{"lockfile_version":1}', "agents.lock"), SkillLockError);
});

test("a future lockfile version is refused instead of being read optimistically", () => {
  const text = JSON.stringify({ lockfile_version: 99, generator: "skill-lock", entries: [] });
  assert.throws(() => parseLockfile(text, "agents.lock"), (error: unknown) => {
    assert.ok(error instanceof SkillLockError);
    assert.match(error.message, /lockfile_version 99/);
    return true;
  });
});

test("a digest that is not a sha256 is rejected", () => {
  const entry = { ...entryFor("prismfy-search"), digest: "md5:abc" };
  const text = JSON.stringify({ lockfile_version: 1, generator: "skill-lock", entries: [entry] });
  assert.throws(() => parseLockfile(text, "agents.lock"), SkillLockError);
});

test("writing then reading a lockfile preserves the bytes", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "agents.lock");
    const lock = fullLockfile();
    await writeLockfile(path, lock);
    const text = await readFile(path, "utf8");
    assert.equal(text, serializeLockfile(lock));
    assert.equal(serializeLockfile(await readLockfile(path)), text);
  });
});

test("a missing lockfile reports a clear error with a hint", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(readLockfile(join(dir, "nope.lock")), (error: unknown) => {
      assert.ok(error instanceof SkillLockError);
      assert.equal(error.kind, "lockfile");
      assert.match(error.hint ?? "", /skill-lock add/);
      return true;
    });
  });
});

test("timestamps live in the sidecar, and the sidecar drops refs that left the lockfile", () => {
  const lock = upsertEntry(emptyLockfile(), entryFor("prismfy-search"));
  const stale = {
    ...emptySidecar(),
    resolutions: { "clawhub:gone/skill@1.0.0": { resolved_at: "2026-01-01T00:00:00.000Z" } },
  };
  const synced = syncSidecar(
    stale,
    lock,
    new Map([[lock.entries[0]!.ref, "2026-08-18T00:00:00.000Z"]]),
  );

  assert.deepEqual(Object.keys(synced.resolutions), [lock.entries[0]!.ref]);
  assert.match(serializeSidecar(synced), /resolved_at/);
  assert.doesNotMatch(serializeLockfile(lock), /resolved_at/);
});

test("an unreadable sidecar degrades to an empty one rather than failing the run", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "agents.lock.meta.json");
    await writeFile(path, "not json", "utf8");
    const { readSidecar } = await import("../src/lockfile.ts");
    const sidecar = await readSidecar(path).catch(() => emptySidecar());
    assert.deepEqual(sidecar.resolutions, {});
  });
});
