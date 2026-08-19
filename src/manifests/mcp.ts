import { canonicalJson, sha256Hex, toJson } from "../canonical.ts";
import { PermissionBuilder, type Permissions } from "../permissions.ts";
import type { McpServer } from "../schema.ts";

/**
 * Normalise an official-registry server record.
 *
 * Note what is NOT here: the MCP server schema has no filesystem-scope field,
 * so `filesystem` stays null for every registry entry. That is a real gap in
 * the format, and reporting it as undeclared is the honest answer. Inferring
 * filesystem access from a server's name or description would be a guess.
 */
export function extractMcpPermissions(server: McpServer): {
  permissions: Permissions;
  warnings: string[];
} {
  const builder = new PermissionBuilder("mcp-registry:server.json");
  const warnings: string[] = [];

  const packages = server.packages ?? [];
  const remotes = server.remotes ?? [];

  if (server.packages !== undefined) builder.touch("exec", "secrets", "network");
  if (server.remotes !== undefined) builder.touch("network", "secrets");

  for (const pkg of packages) {
    if (pkg.registryType !== undefined && pkg.identifier !== undefined) {
      const version = pkg.version === undefined ? "" : `@${pkg.version}`;
      builder.add("exec", "package", `${pkg.registryType}/${pkg.identifier}${version}`);
    }
    if (pkg.runtimeHint !== undefined) builder.add("exec", "runtime", pkg.runtimeHint);
    if (pkg.registryBaseUrl !== undefined) builder.add("network", "url", pkg.registryBaseUrl);
    if (pkg.transport?.type !== undefined) builder.add("network", "transport", pkg.transport.type);
    if (pkg.transport?.url !== undefined) builder.add("network", "url", pkg.transport.url);

    for (const variable of pkg.environmentVariables ?? []) {
      if (variable.name === undefined) continue;
      builder.add("secrets", variable.isSecret === true ? "secret" : "env", variable.name);
    }
    for (const [field, args] of [
      ["runtimeArguments", pkg.runtimeArguments],
      ["packageArguments", pkg.packageArguments],
    ] as const) {
      for (const arg of args ?? []) {
        const identifier = arg.name ?? arg.value;
        if (identifier === undefined) continue;
        builder.add("exec", field === "runtimeArguments" ? "runtime-arg" : "package-arg", identifier);
      }
    }
  }

  for (const remote of remotes) {
    builder.add("network", "url", remote.url);
    if (remote.type !== undefined) builder.add("network", "transport", remote.type);
    for (const header of remote.headers ?? []) {
      if (header.name === undefined) continue;
      if (header.isSecret === true) builder.add("secrets", "header-secret", header.name);
      else builder.add("network", "header", header.name);
    }
  }

  if (packages.length === 0 && remotes.length === 0) {
    warnings.push("mcp-registry: server record declares neither packages nor remotes");
  }

  return { permissions: builder.build(), warnings };
}

export function mcpFields(server: McpServer): Record<string, string | number | boolean | null> {
  const fields: Record<string, string | number | boolean | null> = {
    name: server.name,
    version: server.version,
    schema: server.$schema ?? null,
    package_count: (server.packages ?? []).length,
    remote_count: (server.remotes ?? []).length,
  };
  if (server.repository?.url !== undefined) fields["repository"] = server.repository.url;
  if (server.repository?.subfolder !== undefined) fields["repository_subfolder"] = server.repository.subfolder;
  if (server.websiteUrl !== undefined) fields["website"] = server.websiteUrl;
  if (server.description !== undefined) {
    fields["description_sha256"] = sha256Hex(server.description);
  }
  return fields;
}

/**
 * The registry stamps every read with its own timestamps and cache state. Those
 * describe the query, not the artifact, so they are stripped before the record
 * is digested; otherwise two reads of one immutable version would disagree.
 */
export function digestableServerRecord(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const record = raw as Record<string, unknown>;
  const server = record["server"];
  return server === undefined ? raw : server;
}

export function mcpRecordDigestInput(raw: unknown): string {
  return canonicalJson(toJson(digestableServerRecord(raw)));
}
