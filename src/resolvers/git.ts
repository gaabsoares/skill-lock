import { computeDigest, sha256Hex, type JsonValue } from "../canonical.ts";
import { notFound, upstreamShape } from "../errors.ts";
import { getJson } from "../http.ts";
import { extractMcpPermissions, mcpFields } from "../manifests/mcp.ts";
import { parseOpenClawManifest } from "../manifests/openclaw.ts";
import { undeclared } from "../permissions.ts";
import type { ParsedRef } from "../ref.ts";
import {
  GitHubBlobSchema,
  GitHubCommitSchema,
  GitHubRepoSchema,
  GitHubTreeSchema,
  McpServerSchema,
  type GitHubTreeEntry,
  type LockEntry,
} from "../schema.ts";
import { parseWith, sortedByPath, type ResolveOptions } from "./common.ts";

/** Manifests skill-lock knows how to read, in the order it prefers them. */
const MANIFEST_CANDIDATES = ["SKILL.md", "skill.md", "server.json", ".mcp.json", "mcp.json"] as const;

async function fetchBlobText(
  options: ResolveOptions,
  owner: string,
  repo: string,
  sha: string,
): Promise<string> {
  const url = `${options.githubApiBase}/repos/${owner}/${repo}/git/blobs/${sha}`;
  const json = await getJson(options.fetch, url, `git blob ${sha}`, {
    accept: "application/vnd.github+json",
  });
  const blob = parseWith(GitHubBlobSchema, json, "GitHub blob", url);
  if (blob.encoding !== "base64") {
    throw upstreamShape(`GitHub returned blob ${sha} with unexpected encoding "${blob.encoding}"`, { url });
  }
  return Buffer.from(blob.content, "base64").toString("utf8");
}

export async function resolveGit(ref: ParsedRef, options: ResolveOptions): Promise<LockEntry> {
  if (ref.kind !== "git") throw new Error("resolveGit called with a non-git ref");
  const { owner, repo, subdir } = ref.git;
  const warnings: string[] = [];

  let rev = ref.git.rev;
  if (rev === null) {
    const repoUrl = `${options.githubApiBase}/repos/${owner}/${repo}`;
    const repoJson = await getJson(options.fetch, repoUrl, `repository ${owner}/${repo}`, {
      accept: "application/vnd.github+json",
    });
    rev = parseWith(GitHubRepoSchema, repoJson, "GitHub repository", repoUrl).default_branch;
    warnings.push(`no revision given; resolved against the default branch "${rev}", which moves`);
  }

  const commitUrl = `${options.githubApiBase}/repos/${owner}/${repo}/commits/${encodeURIComponent(rev)}`;
  const commitJson = await getJson(options.fetch, commitUrl, `revision "${rev}" of ${owner}/${repo}`, {
    accept: "application/vnd.github+json",
  });
  const commit = parseWith(GitHubCommitSchema, commitJson, "GitHub commit", commitUrl);

  const treeUrl = `${options.githubApiBase}/repos/${owner}/${repo}/git/trees/${commit.sha}?recursive=1`;
  const treeJson = await getJson(options.fetch, treeUrl, `tree of ${owner}/${repo}@${commit.sha}`, {
    accept: "application/vnd.github+json",
  });
  const tree = parseWith(GitHubTreeSchema, treeJson, "GitHub tree", treeUrl);

  if (tree.truncated === true) {
    throw upstreamShape(
      `GitHub truncated the tree listing for ${owner}/${repo}@${commit.sha}; skill-lock cannot digest a partial tree`,
      { url: treeUrl, hint: "Pin a #subdirectory so the listing fits, or vendor the extension." },
    );
  }

  const prefix = subdir === null ? "" : `${subdir}/`;
  const blobs: GitHubTreeEntry[] = tree.tree.filter(
    (entry) => entry.type === "blob" && entry.path.startsWith(prefix),
  );

  if (blobs.length === 0) {
    throw notFound(
      subdir === null
        ? `${owner}/${repo}@${commit.sha} contains no files`
        : `${owner}/${repo}@${commit.sha} has no files under "${subdir}"`,
      { url: treeUrl },
    );
  }

  const relative = sortedByPath(
    blobs.map((entry) => ({ path: entry.path.slice(prefix.length), mode: entry.mode, sha: entry.sha })),
  );

  const source: Record<string, string | number | boolean | null> = {
    host: "github.com",
    owner,
    repo,
    commit: commit.sha,
    subdir,
    rev_requested: ref.git.rev,
    url: `https://github.com/${owner}/${repo}/tree/${commit.sha}${subdir === null ? "" : `/${subdir}`}`,
  };

  const digest = computeDigest({
    kind: "git",
    coverage: "git-tree",
    source: source as JsonValue,
    content: {
      type: "files",
      hash: "git-blob-sha1",
      entries: relative.map((e) => ({ path: e.path, mode: e.mode, sha1: e.sha })),
    },
  });

  const manifestFields: Record<string, string | number | boolean | null> = {
    commit: commit.sha,
    file_count: relative.length,
    tree_sha: tree.sha,
  };
  const committed = commit.commit?.committer?.date;
  if (committed !== undefined) manifestFields["commit_date"] = committed;

  let permissions = undeclared(null);
  const manifestEntry = MANIFEST_CANDIDATES.map((name) =>
    relative.find((e) => e.path === name),
  ).find((e) => e !== undefined);

  if (manifestEntry === undefined) {
    warnings.push(
      `no manifest found at the root of ${subdir === null ? "the repository" : `"${subdir}"`}; permissions are undeclared`,
    );
  } else {
    const text = await fetchBlobText(options, owner, repo, manifestEntry.sha);
    manifestFields["manifest_path"] = manifestEntry.path;
    manifestFields["manifest_sha256"] = sha256Hex(text);

    if (manifestEntry.path.endsWith(".md")) {
      const parsed = parseOpenClawManifest(text, manifestEntry.path);
      permissions = parsed.permissions;
      warnings.push(...parsed.warnings);
      Object.assign(manifestFields, parsed.fields);
    } else {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw upstreamShape(`${manifestEntry.path} in ${owner}/${repo}@${commit.sha} is not valid JSON`, {
          url: source["url"] as string,
        });
      }
      const server = McpServerSchema.safeParse(json);
      if (server.success) {
        const extracted = extractMcpPermissions(server.data);
        permissions = extracted.permissions;
        warnings.push(...extracted.warnings);
        Object.assign(manifestFields, mcpFields(server.data));
      } else {
        warnings.push(`${manifestEntry.path} is not an MCP server manifest skill-lock recognises; permissions are undeclared`);
      }
    }
  }

  return {
    ref: ref.canonical,
    kind: "git",
    pinned: ref.pinned,
    resolved: source,
    digest,
    digest_covers: "git-tree",
    permissions,
    manifest_fields: manifestFields,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
