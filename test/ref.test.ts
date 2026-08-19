import assert from "node:assert/strict";
import test from "node:test";
import { SkillLockError } from "../src/errors.ts";
import { parseRef } from "../src/ref.ts";

test("clawhub refs carry owner, slug and version", () => {
  const ref = parseRef("clawhub:pskoett/self-improving-agent@4.0.2");
  assert.equal(ref.kind, "clawhub");
  assert.deepEqual(ref.clawhub, { owner: "pskoett", slug: "self-improving-agent", version: "4.0.2" });
  assert.equal(ref.pinned, true);
  assert.equal(ref.canonical, "clawhub:pskoett/self-improving-agent@4.0.2");
});

test("a clawhub ref without a version is not pinned", () => {
  const ref = parseRef("clawhub:uroboros1205/prismfy-search");
  assert.equal(ref.pinned, false);
  assert.equal(ref.clawhub.version, null);
});

test("a bare clawhub slug parses with a null owner and resolves later", () => {
  const ref = parseRef("clawhub:prismfy-search@1.3.8");
  assert.equal(ref.clawhub.owner, null);
  assert.equal(ref.canonical, "clawhub:prismfy-search@1.3.8");
});

test("a clawhub web URL normalises to the same canonical ref as the scheme form", () => {
  assert.equal(
    parseRef("https://clawhub.ai/uroboros1205/skills/prismfy-search").canonical,
    parseRef("clawhub:uroboros1205/prismfy-search").canonical,
  );
});

test("mcp refs keep the reverse-DNS name intact", () => {
  const ref = parseRef("mcp:io.github.brave/brave-search-mcp-server@2.1.0");
  assert.equal(ref.kind, "mcp");
  assert.deepEqual(ref.mcp, { name: "io.github.brave/brave-search-mcp-server", version: "2.1.0" });
  assert.equal(ref.pinned, true);
});

test("an mcp registry URL normalises to the scheme form", () => {
  assert.equal(
    parseRef(
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.brave%2Fbrave-search-mcp-server/versions/2.1.0",
    ).canonical,
    "mcp:io.github.brave/brave-search-mcp-server@2.1.0",
  );
});

test("git refs split revision and subdirectory", () => {
  const ref = parseRef("github.com/anthropics/skills@0a64e398ec6bb34a494f0c347e8ccae53a862f8e#skills/mcp-builder");
  assert.equal(ref.kind, "git");
  assert.deepEqual(ref.git, {
    host: "github.com",
    owner: "anthropics",
    repo: "skills",
    rev: "0a64e398ec6bb34a494f0c347e8ccae53a862f8e",
    subdir: "skills/mcp-builder",
  });
  assert.equal(ref.pinned, true);
});

test("only a full commit sha counts as pinned: branches and tags move", () => {
  assert.equal(parseRef("github.com/o/r@main").pinned, false);
  assert.equal(parseRef("github.com/o/r@v1.2.3").pinned, false);
  assert.equal(parseRef("github.com/o/r").pinned, false);
  assert.equal(parseRef(`github.com/o/r@${"a".repeat(40)}`).pinned, true);
});

test("git scheme prefixes and a .git suffix all reach the same canonical ref", () => {
  const canonical = "git+https://github.com/o/r";
  for (const input of [
    "github.com/o/r",
    "https://github.com/o/r",
    "git+https://github.com/o/r",
    "https://github.com/o/r.git",
  ]) {
    assert.equal(parseRef(input).canonical, canonical, input);
  }
});

test("unsupported git hosts fail loudly instead of falling back", () => {
  assert.throws(() => parseRef("gitlab.com/o/r"), (error: unknown) => {
    assert.ok(error instanceof SkillLockError);
    assert.equal(error.kind, "invalid-ref");
    return true;
  });
});

test("subdirectory traversal is rejected", () => {
  assert.throws(() => parseRef("github.com/o/r#../../etc"), SkillLockError);
});

test("unrecognised and empty refs are rejected with exit code 3", () => {
  for (const input of ["", "   ", "not a ref", "npm:left-pad"]) {
    assert.throws(
      () => parseRef(input),
      (error: unknown) => {
        assert.ok(error instanceof SkillLockError);
        assert.equal(error.exitCode, 3);
        return true;
      },
      input,
    );
  }
});

test("an empty version is rejected rather than treated as latest", () => {
  assert.throws(() => parseRef("clawhub:owner/slug@"), SkillLockError);
});
