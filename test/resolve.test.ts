import assert from "node:assert/strict";
import test from "node:test";
import { SkillLockError } from "../src/errors.ts";
import { parseRef } from "../src/ref.ts";
import { resolveParsed } from "../src/resolvers/index.ts";
import { entryFor, expected, offlineOptions } from "./helpers.ts";

const CLAWHUB_DETAIL =
  "https://clawhub.ai/api/v1/skills/prismfy-search?owner=uroboros1205";
const CLAWHUB_SKILL_FILE =
  "https://clawhub.ai/api/v1/skills/prismfy-search/file?path=SKILL.md&version=1.3.8&owner=uroboros1205";
const MCP_VERSION =
  "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.brave%2Fbrave-search-mcp-server/versions/2.1.0";

test("every recorded reference resolves offline to exactly the recorded entry", async () => {
  for (const ref of expected.refs) {
    const entry = await resolveParsed(parseRef(ref), offlineOptions());
    assert.deepEqual(entry, entryFor(ref), ref);
  }
});

test("resolving twice produces an identical entry (no wall clock in the result)", async () => {
  for (const ref of expected.refs) {
    const first = await resolveParsed(parseRef(ref), offlineOptions());
    const second = await resolveParsed(parseRef(ref), offlineOptions());
    assert.equal(JSON.stringify(first), JSON.stringify(second), ref);
  }
});

test("all three reference forms produce the same normalised permission model", async () => {
  const kinds = new Set<string>();
  for (const ref of expected.refs) {
    const entry = await resolveParsed(parseRef(ref), offlineOptions());
    kinds.add(entry.kind);
    for (const axis of ["filesystem", "network", "secrets", "exec"] as const) {
      const value = entry.permissions[axis];
      assert.ok(value === null || Array.isArray(value), `${ref} ${axis}`);
    }
    assert.match(entry.digest, /^sha256:[0-9a-f]{64}$/);
  }
  assert.deepEqual([...kinds].sort(), ["clawhub", "git", "mcp"]);
});

test("a ClawHub skill declaring a secret is read from the legacy and current metadata keys alike", async () => {
  const old = await resolveParsed(
    parseRef("clawhub:nextfrontierbuilds/elite-longterm-memory@0.1.0"),
    offlineOptions(),
  );
  const current = await resolveParsed(
    parseRef("clawhub:nextfrontierbuilds/elite-longterm-memory@1.2.3"),
    offlineOptions(),
  );
  assert.equal(old.permissions.manifest, "SKILL.md:metadata.clawdbot");
  assert.equal(current.permissions.manifest, "SKILL.md:metadata.openclaw");
  assert.deepEqual(old.permissions.secrets, ["env:OPENAI_API_KEY"]);
  assert.deepEqual(current.permissions.secrets, ["env:OPENAI_API_KEY"]);
  assert.notEqual(old.digest, current.digest, "different versions must not share a digest");
});

test("a widely installed skill with no permission metadata reports undeclared, not empty", async () => {
  const entry = await resolveParsed(parseRef("clawhub:pskoett/self-improving-agent@4.0.2"), offlineOptions());
  assert.equal(entry.permissions.status, "undeclared");
  assert.equal(entry.permissions.secrets, null);
  assert.equal(entry.permissions.exec, null);
  assert.equal(entry.manifest_fields["file_count"], 15);
});

test("an unpinned git ref resolves to a commit but warns that it tracks a moving branch", async () => {
  const entry = await resolveParsed(
    parseRef("github.com/modelcontextprotocol/servers#src/filesystem"),
    offlineOptions(),
  );
  assert.equal(entry.pinned, false);
  assert.match(String(entry.resolved["commit"]), /^[0-9a-f]{40}$/);
  assert.ok(entry.warnings?.some((w) => w.includes("default branch")));
});

test("a subdirectory ref digests only that subdirectory", async () => {
  const entry = await resolveParsed(
    parseRef("github.com/anthropics/skills@0a64e398ec6bb34a494f0c347e8ccae53a862f8e#skills/mcp-builder"),
    offlineOptions(),
  );
  assert.equal(entry.resolved["subdir"], "skills/mcp-builder");
  assert.equal(entry.manifest_fields["file_count"], 10, "the whole repo has far more files than this");
  assert.equal(entry.manifest_fields["manifest_path"], "SKILL.md");
});

test("an ambiguous ClawHub slug fails loudly and names every candidate owner", async () => {
  const url = "https://clawhub.ai/api/v1/skills/self-improving-agent";
  const body = JSON.stringify({
    code: "AMBIGUOUS_SKILL_SLUG",
    message: 'Found multiple skills with the slug "self-improving-agent"',
    slug: "self-improving-agent",
    matches: [
      { ownerHandle: "pskoett", slug: "self-improving-agent", ref: "@pskoett/self-improving-agent" },
      { ownerHandle: "thcjp", slug: "self-improving-agent", ref: "@thcjp/self-improving-agent" },
    ],
  });

  await assert.rejects(
    resolveParsed(parseRef("clawhub:self-improving-agent"), offlineOptions({ [url]: { status: 409, body } })),
    (error: unknown) => {
      assert.ok(error instanceof SkillLockError);
      assert.equal(error.kind, "ambiguous-ref");
      assert.equal(error.exitCode, 3);
      assert.deepEqual(error.detail["owners"], ["pskoett", "thcjp"]);
      assert.match(error.hint ?? "", /clawhub:pskoett\/self-improving-agent/);
      return true;
    },
  );
});

test("content that does not match the registry's declared hash is an integrity failure", async () => {
  await assert.rejects(
    resolveParsed(
      parseRef("clawhub:uroboros1205/prismfy-search@1.3.8"),
      offlineOptions({ [CLAWHUB_SKILL_FILE]: { status: 200, body: "tampered" } }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SkillLockError);
      assert.equal(error.kind, "integrity");
      assert.equal(error.exitCode, 4);
      return true;
    },
  );
});

test("a missing upstream record is 'does not exist', distinct from 'cannot reach'", async () => {
  await assert.rejects(
    resolveParsed(
      parseRef("mcp:io.github.brave/brave-search-mcp-server@2.1.0"),
      offlineOptions({ [MCP_VERSION]: { status: 404, body: '{"title":"Not Found"}' } }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SkillLockError);
      assert.equal(error.kind, "not-found");
      assert.equal(error.exitCode, 3);
      return true;
    },
  );
});

test("a network failure is reported as unreachable with an operational exit code", async () => {
  await assert.rejects(
    resolveParsed(
      parseRef("mcp:io.github.brave/brave-search-mcp-server@2.1.0"),
      offlineOptions({ [MCP_VERSION]: { status: 0 } }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SkillLockError);
      assert.equal(error.kind, "unreachable");
      assert.equal(error.exitCode, 2);
      return true;
    },
  );
});

test("upstream shape drift stops the resolution instead of producing a meaningless digest", async () => {
  await assert.rejects(
    resolveParsed(
      parseRef("mcp:io.github.brave/brave-search-mcp-server@2.1.0"),
      offlineOptions({ [MCP_VERSION]: { status: 200, body: '{"server":{"name":"x"}}' } }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SkillLockError);
      assert.equal(error.kind, "upstream-shape");
      assert.equal(error.exitCode, 4);
      return true;
    },
  );
});

test("a ClawHub response that is not JSON fails loudly", async () => {
  await assert.rejects(
    resolveParsed(
      parseRef("clawhub:uroboros1205/prismfy-search@1.3.8"),
      offlineOptions({ [CLAWHUB_DETAIL]: { status: 200, body: "<html>maintenance</html>" } }),
    ),
    SkillLockError,
  );
});

test("skipping content fetch is recorded in the digest coverage, not hidden", async () => {
  const { resolveOptions: makeOptions } = await import("../src/resolvers/index.ts");
  const { fixtureFetcher } = await import("./helpers.ts");
  const verified = await resolveParsed(parseRef("clawhub:uroboros1205/prismfy-search@1.3.8"), offlineOptions());
  const trusted = await resolveParsed(
    parseRef("clawhub:uroboros1205/prismfy-search@1.3.8"),
    makeOptions({ fetch: fixtureFetcher().fetch, fetchContent: false }),
  );

  assert.equal(verified.digest_covers, "file-contents");
  assert.equal(trusted.digest_covers, "file-manifest");
  assert.notEqual(verified.digest, trusted.digest, "a trusted-hash digest must not collide with a verified one");
  assert.ok(trusted.warnings?.some((w) => w.includes("not independently verified")));
});
