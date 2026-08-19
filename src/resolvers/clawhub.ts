import { computeDigest, sha256Hex, type JsonValue } from "../canonical.ts";
import { ambiguousRef, integrity, notFound, upstreamShape } from "../errors.ts";
import { decodeUtf8, getJson } from "../http.ts";
import { parseOpenClawManifest } from "../manifests/openclaw.ts";
import type { ParsedRef } from "../ref.ts";
import {
  ClawHubAmbiguousSchema,
  ClawHubSkillDetailSchema,
  ClawHubVersionDetailSchema,
  type LockEntry,
} from "../schema.ts";
import { parseWith, sortedByPath, type ResolveOptions } from "./common.ts";

const SKILL_MANIFEST = "SKILL.md";

function ownerQuery(owner: string | null): string {
  return owner === null ? "" : `?owner=${encodeURIComponent(owner)}`;
}

function parseJsonBody(body: Uint8Array, what: string, url: string): unknown {
  const text = decodeUtf8(body);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw upstreamShape(`${what} did not return JSON`, { url, body: text.slice(0, 300) });
  }
}

/**
 * ClawHub slugs are not unique: several owners can publish the same name, and
 * the registry answers an unscoped lookup for one of those with 409. That is a
 * real namespace collision, so it is surfaced as an ambiguous-ref error listing
 * every candidate rather than resolved to whichever one happens to rank first.
 */
async function fetchSkillDetail(ref: ParsedRef & { kind: "clawhub" }, options: ResolveOptions) {
  const { slug, owner } = ref.clawhub;
  const url = `${options.clawhubBase}/skills/${encodeURIComponent(slug)}${ownerQuery(owner)}`;
  const res = await options.fetch(url);

  if (res.status === 409) {
    const body = parseJsonBody(res.body, `ClawHub conflict response for "${slug}"`, url);
    const parsed = ClawHubAmbiguousSchema.safeParse(body);
    if (parsed.success) {
      const owners = parsed.data.matches.map((m) => m.ownerHandle);
      throw ambiguousRef(
        `ClawHub slug "${slug}" is published by ${owners.length} different owners`,
        { slug, owners, matches: parsed.data.matches },
        `Pin the owner: ${owners.map((o) => `clawhub:${o}/${slug}`).join(", ")}`,
      );
    }
    throw upstreamShape(`ClawHub returned 409 for "${slug}" in a form skill-lock cannot read`, {
      url,
      body: decodeUtf8(res.body).slice(0, 300),
    });
  }

  if (res.status === 404) {
    throw notFound(
      `ClawHub has no skill "${slug}"${owner === null ? "" : ` owned by "${owner}"`}`,
      { url },
    );
  }
  if (res.status !== 200) {
    throw upstreamShape(`unexpected HTTP ${res.status} from ClawHub skill lookup`, { url, status: res.status });
  }

  const json = parseJsonBody(res.body, `ClawHub skill detail for "${slug}"`, url);
  return { detail: parseWith(ClawHubSkillDetailSchema, json, "ClawHub skill detail", url), url };
}

export async function resolveClawHub(ref: ParsedRef, options: ResolveOptions): Promise<LockEntry> {
  if (ref.kind !== "clawhub") throw new Error("resolveClawHub called with a non-ClawHub ref");
  const { slug } = ref.clawhub;

  const { detail, url: detailUrl } = await fetchSkillDetail(ref, options);
  const owner = ref.clawhub.owner ?? detail.owner?.handle ?? null;
  const version = ref.clawhub.version ?? detail.latestVersion?.version ?? detail.skill.tags?.["latest"] ?? null;

  if (version === null) {
    throw upstreamShape(`ClawHub did not report a latest version for "${slug}"`, {
      url: detailUrl,
      hint: "Pin an explicit version, for example clawhub:owner/slug@1.2.3",
    });
  }

  const versionUrl = `${options.clawhubBase}/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}${ownerQuery(owner)}`;
  const versionJson = await getJson(options.fetch, versionUrl, `ClawHub skill "${slug}" version ${version}`);
  const versionDetail = parseWith(ClawHubVersionDetailSchema, versionJson, "ClawHub version detail", versionUrl);

  const files = sortedByPath(versionDetail.version.files);
  const warnings: string[] = [];
  const entries: JsonValue[] = [];
  let manifestSource: string | null = null;

  if (options.fetchContent) {
    for (const file of files) {
      const fileUrl = `${options.clawhubBase}/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(file.path)}&version=${encodeURIComponent(version)}${owner === null ? "" : `&owner=${encodeURIComponent(owner)}`}`;
      const res = await options.fetch(fileUrl, { accept: "*/*" });
      if (res.status !== 200) {
        throw upstreamShape(`ClawHub listed "${file.path}" but serving it returned HTTP ${res.status}`, {
          url: fileUrl,
          status: res.status,
        });
      }
      const actual = sha256Hex(res.body);
      if (actual !== file.sha256) {
        throw integrity(
          `content hash mismatch for "${file.path}" in ${slug}@${version}`,
          { url: fileUrl, declared_sha256: file.sha256, actual_sha256: actual },
        );
      }
      entries.push({ path: file.path, sha256: actual, size: res.body.byteLength });
      if (file.path === SKILL_MANIFEST) manifestSource = decodeUtf8(res.body);
    }
  } else {
    for (const file of files) {
      entries.push({ path: file.path, sha256: file.sha256, size: file.size ?? 0 });
    }
    warnings.push("content not fetched: per-file hashes are the registry's, not independently verified");
    if (detail.skill.description !== null && detail.skill.description !== undefined) {
      manifestSource = detail.skill.description;
    }
  }

  if (manifestSource === null && files.some((f) => f.path === SKILL_MANIFEST)) {
    warnings.push(`${SKILL_MANIFEST} was listed but could not be read for permission extraction`);
  }

  const manifest =
    manifestSource === null
      ? { permissions: { status: "undeclared", manifest: null, filesystem: null, network: null, secrets: null, exec: null } as const, warnings: [], fields: {} }
      : parseOpenClawManifest(manifestSource, SKILL_MANIFEST);
  warnings.push(...manifest.warnings);

  const source: Record<string, string | number | boolean | null> = {
    registry: "clawhub.ai",
    owner,
    slug,
    version,
    url: owner === null ? `https://clawhub.ai/skills/${slug}` : `https://clawhub.ai/${owner}/skills/${slug}`,
    api_url: versionUrl,
  };

  const digest = computeDigest({
    kind: "clawhub",
    coverage: options.fetchContent ? "file-contents" : "file-manifest",
    source: source as JsonValue,
    content: { type: "files", hash: "sha256", entries },
  });

  const manifestFields: Record<string, string | number | boolean | null> = {
    ...manifest.fields,
    owner,
    version,
    file_count: files.length,
    license: versionDetail.version.license ?? null,
  };
  const skillMd = files.find((f) => f.path === SKILL_MANIFEST);
  if (skillMd !== undefined) manifestFields["skill_md_sha256"] = skillMd.sha256;

  return {
    ref: ref.canonical,
    kind: "clawhub",
    pinned: ref.pinned,
    resolved: source,
    digest,
    digest_covers: options.fetchContent ? "file-contents" : "file-manifest",
    permissions: manifest.permissions,
    manifest_fields: manifestFields,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
