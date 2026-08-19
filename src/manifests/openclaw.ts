import { parse as parseYaml } from "yaml";
import { canonicalJson, sha256Hex, toJson } from "../canonical.ts";
import { PermissionBuilder, undeclared, type Permissions } from "../permissions.ts";

export interface OpenClawManifest {
  frontmatter: Record<string, unknown> | null;
  permissions: Permissions;
  warnings: string[];
  fields: Record<string, string | number | boolean | null>;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function extractFrontmatter(source: string): Record<string, unknown> | null {
  const match = FRONTMATTER.exec(source);
  if (match === null) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]!, { strict: false });
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asString = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;

/** OpenClaw frontmatter lists are hand-authored: accept `[a, b]`, `a`, or `[{name: a}]`. */
function eachName(value: unknown, onName: (name: string) => void, onUnknown: (v: unknown) => void): void {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    const direct = asString(item);
    if (direct !== null) {
      if (direct.trim() !== "") onName(direct.trim());
      continue;
    }
    const record = asRecord(item);
    const named = record === null ? null : asString(record["name"] ?? record["key"] ?? record["var"]);
    if (named !== null) {
      onName(named.trim());
      continue;
    }
    if (item === null || item === undefined) continue;
    onUnknown(item);
  }
}

const looksLikeUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
const looksLikePath = (s: string) => s.startsWith("~") || s.startsWith("/") || s.startsWith("./") || s.startsWith("../");

/**
 * Normalise the `metadata.openclaw` block of an OpenClaw skill.
 *
 * Only fields the format actually defines become capabilities. An axis with no
 * corresponding field stays null (undeclared) rather than being inferred from
 * the skill's prose, which would be a guess dressed up as a permission.
 */
export function extractOpenClawPermissions(
  frontmatter: Record<string, unknown> | null,
  manifestPath: string,
): { permissions: Permissions; warnings: string[]; metadataDigest: string | null } {
  if (frontmatter === null) {
    return { permissions: undeclared(null), warnings: [], metadataDigest: null };
  }

  const metadata = asRecord(frontmatter["metadata"]);
  // skills published before the Clawdbot to OpenClaw rename still carry their
  // requirements under the old key; missing them would report a declared
  // secret as undeclared, which is the one mistake this tool must not make
  const openclaw =
    metadata === null ? null : (asRecord(metadata["openclaw"]) ?? asRecord(metadata["clawdbot"]));
  const allowedTools = frontmatter["allowed-tools"] ?? frontmatter["allowed_tools"];

  if (openclaw === null && allowedTools === undefined) {
    // the manifest was read and simply declares nothing; recording where we
    // looked keeps that distinct from never having found a manifest at all
    return { permissions: undeclared(manifestPath), warnings: [], metadataDigest: null };
  }

  const metadataKey =
    metadata !== null && asRecord(metadata["openclaw"]) === null && asRecord(metadata["clawdbot"]) !== null
      ? "clawdbot"
      : "openclaw";
  const label =
    openclaw === null ? `${manifestPath}:allowed-tools` : `${manifestPath}:metadata.${metadataKey}`;
  const builder = new PermissionBuilder(label);

  if (allowedTools !== undefined) {
    builder.touch("exec");
    eachName(
      allowedTools,
      (name) => builder.add("exec", "tool", name),
      (v) => builder.addUnrecognized("exec", "allowed-tools", v),
    );
  }

  if (openclaw !== null) {
    const requires = asRecord(openclaw["requires"]);
    if (requires !== null) {
      if ("env" in requires) {
        builder.touch("secrets");
        eachName(
          requires["env"],
          (name) => builder.add("secrets", "env", name),
          (v) => builder.addUnrecognized("secrets", "requires.env", v),
        );
      }
      if ("bins" in requires) {
        builder.touch("exec");
        eachName(
          requires["bins"],
          (name) => builder.add("exec", "bin", name),
          (v) => builder.addUnrecognized("exec", "requires.bins", v),
        );
      }
      if ("config" in requires) {
        builder.touch("secrets");
        eachName(
          requires["config"],
          (name) => builder.add("secrets", "config", name),
          (v) => builder.addUnrecognized("secrets", "requires.config", v),
        );
      }
      if ("plugins" in requires) {
        builder.touch("exec");
        eachName(
          requires["plugins"],
          (name) => builder.add("exec", "plugin", name),
          (v) => builder.addUnrecognized("exec", "requires.plugins", v),
        );
      }
    }

    const primaryEnv = asString(openclaw["primaryEnv"]);
    if (primaryEnv !== null) builder.add("secrets", "env", primaryEnv);

    if ("install" in openclaw) {
      builder.touch("network", "filesystem", "exec");
      const steps = Array.isArray(openclaw["install"]) ? openclaw["install"] : [openclaw["install"]];
      for (const [index, rawStep] of steps.entries()) {
        const step = asRecord(rawStep);
        if (step === null) {
          if (rawStep !== null && rawStep !== undefined) {
            builder.addUnrecognized("exec", `install[${index}]`, rawStep);
          }
          continue;
        }
        const kind = asString(step["kind"]);
        if (kind !== null) builder.add("exec", "install", kind);

        for (const [key, value] of Object.entries(step)) {
          if (key === "kind") continue;
          if (key === "bins") {
            eachName(
              value,
              (name) => builder.add("exec", "bin", name),
              (v) => builder.addUnrecognized("exec", `install[${index}].bins`, v),
            );
            continue;
          }
          const scalar = asString(value);
          if (scalar === null) continue;
          if (looksLikeUrl(scalar)) builder.add("network", "url", scalar);
          else if (looksLikePath(scalar)) builder.add("filesystem", "path", scalar);
          else if (key === "cmd" || key === "command" || key === "run") builder.add("exec", "command", scalar);
        }
      }
    }
  }

  const digestSource = openclaw === null ? { "allowed-tools": allowedTools } : openclaw;
  const permissions = builder.build();
  return {
    // a metadata block that declares no capability still means we read a
    // manifest, which is a different claim from having found none
    permissions: permissions.manifest === null ? { ...permissions, manifest: manifestPath } : permissions,
    warnings: builder.warnings,
    metadataDigest: sha256Hex(canonicalJson(toJson(digestSource))),
  };
}

export function openClawFields(
  frontmatter: Record<string, unknown> | null,
): Record<string, string | number | boolean | null> {
  if (frontmatter === null) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of ["name", "version", "license", "repository", "homepage", "author"]) {
    const value = asString(frontmatter[key]);
    if (value !== null) out[`frontmatter_${key}`] = value;
  }
  return out;
}

export function parseOpenClawManifest(source: string, manifestPath: string): OpenClawManifest {
  const frontmatter = extractFrontmatter(source);
  const { permissions, warnings, metadataDigest } = extractOpenClawPermissions(frontmatter, manifestPath);
  const fields = openClawFields(frontmatter);
  if (metadataDigest !== null) fields["openclaw_metadata_sha256"] = metadataDigest;
  return { frontmatter, permissions, warnings, fields };
}
