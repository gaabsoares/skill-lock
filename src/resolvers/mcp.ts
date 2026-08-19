import { computeDigest, sha256Of, type JsonValue } from "../canonical.ts";
import { notFound, upstreamShape } from "../errors.ts";
import { getJson } from "../http.ts";
import { extractMcpPermissions, mcpFields, mcpRecordDigestInput } from "../manifests/mcp.ts";
import type { ParsedRef } from "../ref.ts";
import { McpServerEnvelopeSchema, McpVersionListSchema, type LockEntry } from "../schema.ts";
import { parseWith, type ResolveOptions } from "./common.ts";

const REGISTRY_META_KEY = "io.modelcontextprotocol.registry/official";

function isLatest(meta: unknown): boolean {
  if (meta === null || typeof meta !== "object") return false;
  const official = (meta as Record<string, unknown>)[REGISTRY_META_KEY];
  if (official === null || typeof official !== "object") return false;
  return (official as Record<string, unknown>)["isLatest"] === true;
}

export async function resolveMcp(ref: ParsedRef, options: ResolveOptions): Promise<LockEntry> {
  if (ref.kind !== "mcp") throw new Error("resolveMcp called with a non-MCP ref");
  const { name, version } = ref.mcp;
  const encodedName = encodeURIComponent(name);

  let raw: unknown;
  let url: string;

  if (version !== null) {
    url = `${options.mcpBase}/servers/${encodedName}/versions/${encodeURIComponent(version)}`;
    raw = await getJson(options.fetch, url, `MCP server "${name}" version ${version}`);
  } else {
    const listUrl = `${options.mcpBase}/servers/${encodedName}/versions`;
    const listJson = await getJson(options.fetch, listUrl, `MCP server "${name}"`);
    const list = parseWith(McpVersionListSchema, listJson, "MCP version list", listUrl);
    if (list.servers.length === 0) {
      throw notFound(`MCP registry lists no versions for "${name}"`, { url: listUrl });
    }
    const latest = list.servers.filter((s) => isLatest(s._meta));
    if (latest.length !== 1) {
      throw upstreamShape(
        `MCP registry marks ${latest.length} versions of "${name}" as latest; skill-lock needs exactly one`,
        {
          url: listUrl,
          available: list.servers.map((s) => s.server.version),
          hint: `Pin a version explicitly, for example mcp:${name}@${list.servers.at(-1)?.server.version ?? "1.0.0"}`,
        },
      );
    }
    raw = latest[0];
    url = `${options.mcpBase}/servers/${encodedName}/versions/${encodeURIComponent(latest[0]!.server.version)}`;
  }

  const envelope = parseWith(McpServerEnvelopeSchema, raw, "MCP server record", url);
  const server = envelope.server;
  const { permissions, warnings } = extractMcpPermissions(server);

  const source: Record<string, string | number | boolean | null> = {
    registry: "registry.modelcontextprotocol.io",
    name: server.name,
    version: server.version,
    url: `${options.mcpBase}/servers/${encodedName}/versions/${encodeURIComponent(server.version)}`,
    schema: server.$schema ?? null,
  };

  const digest = computeDigest({
    kind: "mcp",
    coverage: "registry-record",
    source: source as JsonValue,
    content: { type: "record", sha256: sha256Of(mcpRecordDigestInput(raw)) },
  });

  return {
    ref: ref.canonical,
    kind: "mcp",
    pinned: ref.pinned,
    resolved: source,
    digest,
    digest_covers: "registry-record",
    permissions,
    manifest_fields: mcpFields(server),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
