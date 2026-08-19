import { invalidRef } from "./errors.ts";

export type RefKind = "clawhub" | "mcp" | "git";

export interface ClawHubRef {
  owner: string | null;
  slug: string;
  version: string | null;
}

export interface McpRef {
  name: string;
  version: string | null;
}

export interface GitRef {
  host: "github.com";
  owner: string;
  repo: string;
  /** branch, tag, or commit sha as written; null means "the repository default branch" */
  rev: string | null;
  subdir: string | null;
}

export type ParsedRef =
  | { raw: string; canonical: string; kind: "clawhub"; pinned: boolean; clawhub: ClawHubRef }
  | { raw: string; canonical: string; kind: "mcp"; pinned: boolean; mcp: McpRef }
  | { raw: string; canonical: string; kind: "git"; pinned: boolean; git: GitRef };

const SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const OWNER = /^[a-z0-9][a-z0-9._-]*$/i;
const FULL_SHA = /^[0-9a-f]{40}$/;
const MCP_NAME = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._~-]*$/i;

/** Split a trailing `@version`, ignoring any `@` that is part of a leading scope. */
function splitVersion(input: string): { base: string; version: string | null } {
  const at = input.lastIndexOf("@");
  if (at <= 0) return { base: input, version: null };
  const version = input.slice(at + 1);
  if (version === "") {
    throw invalidRef(`empty version in ref "${input}"`, "Write `name@1.2.3`, or drop the `@` to track the latest version.");
  }
  return { base: input.slice(0, at), version };
}

function parseClawHub(rest: string, raw: string): ParsedRef {
  const { base, version } = splitVersion(rest);
  const parts = base.split("/").filter((p) => p !== "");
  let owner: string | null = null;
  let slug: string;

  if (parts.length === 1) {
    slug = parts[0]!;
  } else if (parts.length === 2) {
    owner = parts[0]!.replace(/^@/, "");
    slug = parts[1]!;
  } else {
    throw invalidRef(
      `cannot parse ClawHub ref "${raw}"`,
      "Expected `clawhub:<owner>/<slug>[@<version>]`, for example `clawhub:pskoett/self-improving-agent@4.0.2`.",
    );
  }

  if (!SLUG.test(slug)) throw invalidRef(`"${slug}" is not a valid ClawHub slug (from "${raw}")`);
  if (owner !== null && !OWNER.test(owner)) {
    throw invalidRef(`"${owner}" is not a valid ClawHub owner handle (from "${raw}")`);
  }

  const canonical = `clawhub:${owner === null ? "" : `${owner}/`}${slug}${version === null ? "" : `@${version}`}`;
  return { raw, canonical, kind: "clawhub", pinned: version !== null, clawhub: { owner, slug, version } };
}

function parseMcp(rest: string, raw: string): ParsedRef {
  const { base, version } = splitVersion(rest);
  if (!MCP_NAME.test(base)) {
    throw invalidRef(
      `"${base}" is not a valid MCP server name (from "${raw}")`,
      "MCP registry names are reverse-DNS scoped, for example `mcp:ai.smithery/Hint-Services-obsidian-github-mcp@0.4.0`.",
    );
  }
  const canonical = `mcp:${base}${version === null ? "" : `@${version}`}`;
  return { raw, canonical, kind: "mcp", pinned: version !== null, mcp: { name: base, version } };
}

function parseGit(rest: string, raw: string): ParsedRef {
  let body = rest;
  let subdir: string | null = null;

  const hash = body.indexOf("#");
  if (hash >= 0) {
    subdir = body.slice(hash + 1).replace(/^\/+|\/+$/g, "");
    body = body.slice(0, hash);
    if (subdir === "") subdir = null;
    if (subdir !== null && (subdir.includes("..") || subdir.startsWith("/"))) {
      throw invalidRef(`subdirectory "${subdir}" in "${raw}" must be a plain repository-relative path`);
    }
  }

  body = body.replace(/\.git$/, "");

  const slash = body.indexOf("/");
  if (slash < 0) throw invalidRef(`cannot parse git ref "${raw}"`, "Expected `github.com/<owner>/<repo>[@<rev>][#<subdir>]`.");
  const host = body.slice(0, slash);
  if (host !== "github.com") {
    throw invalidRef(
      `unsupported git host "${host}" in "${raw}"`,
      "skill-lock 0.1 resolves github.com only. Other hosts are a stated gap, not a silent fallback.",
    );
  }

  const path = body.slice(slash + 1);
  const { base, version: rev } = splitVersion(path);
  const parts = base.split("/").filter((p) => p !== "");
  if (parts.length !== 2) {
    throw invalidRef(`cannot parse owner/repo out of "${raw}"`, "Expected `github.com/<owner>/<repo>[@<rev>][#<subdir>]`.");
  }
  const [owner, repo] = parts as [string, string];

  const canonical = `git+https://github.com/${owner}/${repo}${rev === null ? "" : `@${rev}`}${subdir === null ? "" : `#${subdir}`}`;
  return {
    raw,
    canonical,
    kind: "git",
    // only a full commit sha is a real pin: branches and tags are both mutable
    pinned: rev !== null && FULL_SHA.test(rev),
    git: { host: "github.com", owner, repo, rev, subdir },
  };
}

/**
 * Accepted forms:
 *   clawhub:<owner>/<slug>[@<version>]         (bare `<slug>` allowed; fails loud if several owners publish it)
 *   https://clawhub.ai/<owner>/skills/<slug>[@<version>]
 *   mcp:<serverName>[@<version>]
 *   https://registry.modelcontextprotocol.io/v0.1/servers/<serverName>[/versions/<version>]
 *   git+https://github.com/<owner>/<repo>[@<rev>][#<subdir>]
 *   https://github.com/<owner>/<repo>[@<rev>][#<subdir>]
 *   github.com/<owner>/<repo>[@<rev>][#<subdir>]
 */
export function parseRef(raw: string): ParsedRef {
  const input = raw.trim();
  if (input === "") throw invalidRef("empty reference");

  if (input.startsWith("clawhub:")) return parseClawHub(input.slice("clawhub:".length), input);
  if (input.startsWith("mcp:")) return parseMcp(input.slice("mcp:".length), input);
  if (input.startsWith("git+")) return parseGit(stripScheme(input.slice("git+".length)), input);

  const bare = stripScheme(input);

  if (bare.startsWith("clawhub.ai/")) {
    // https://clawhub.ai/<owner>/skills/<slug>
    const segs = bare.split("/").filter((s) => s !== "");
    if (segs.length >= 4 && segs[2] === "skills") {
      return parseClawHub(`${segs[1]}/${segs.slice(3).join("/")}`, input);
    }
    throw invalidRef(`cannot parse ClawHub URL "${raw}"`, "Expected `https://clawhub.ai/<owner>/skills/<slug>`.");
  }

  if (bare.startsWith("registry.modelcontextprotocol.io/")) {
    const m = /\/servers\/([^/?#]+)(?:\/versions\/([^/?#]+))?/.exec(bare);
    if (m) {
      const name = decodeURIComponent(m[1]!);
      return parseMcp(m[2] === undefined ? name : `${name}@${decodeURIComponent(m[2])}`, input);
    }
    throw invalidRef(`cannot parse MCP registry URL "${raw}"`, "Expected `.../v0.1/servers/<serverName>[/versions/<version>]`.");
  }

  // anything shaped like <host>/<owner>/<repo> goes to the git parser so an
  // unsupported host is named as such instead of reported as unparseable
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\/[^/]+\/[^/]+/i.test(bare)) return parseGit(bare, input);

  throw invalidRef(
    `unrecognised reference "${raw}"`,
    "Supported forms: `clawhub:<owner>/<slug>[@<version>]`, `mcp:<serverName>[@<version>]`, `github.com/<owner>/<repo>[@<rev>][#<subdir>]`.",
  );
}

function stripScheme(input: string): string {
  return input.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/+/, "");
}
