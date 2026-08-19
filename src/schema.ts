import { z } from "zod";
import type { DigestCoverage } from "./canonical.ts";
import type { Permissions } from "./permissions.ts";
import type { RefKind } from "./ref.ts";

/*
 * Upstream schemas validate only the fields skill-lock depends on. Unknown
 * fields are ignored here on purpose: registries add fields constantly, and
 * refusing to resolve because a new optional key appeared would be noise. What
 * must never pass quietly is a field we DO depend on changing shape or
 * vanishing, which is what these schemas catch.
 *
 * Digests are always computed over the raw parsed JSON, never over the output
 * of these schemas, so fields skill-lock does not model still change the digest.
 */

export const ClawHubFileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.string().optional(),
});

export const ClawHubVersionDetailSchema = z.object({
  skill: z.object({ slug: z.string(), displayName: z.string().optional() }).optional(),
  version: z.object({
    version: z.string(),
    createdAt: z.number().optional(),
    changelog: z.string().nullable().optional(),
    license: z.string().nullable().optional(),
    files: z.array(ClawHubFileSchema).min(1),
  }),
});

export const ClawHubSkillDetailSchema = z.object({
  skill: z.object({
    slug: z.string(),
    displayName: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    tags: z.record(z.string(), z.string()).nullable().optional(),
  }),
  // present on an unscoped lookup; null when the request is owner-scoped, in
  // which case the latest version has to come from skill.tags.latest instead
  latestVersion: z.object({ version: z.string(), license: z.string().nullable().optional() }).nullable().optional(),
  owner: z.object({ handle: z.string(), displayName: z.string().nullable().optional() }).nullable().optional(),
});

export const ClawHubVersionListSchema = z.object({
  items: z.array(z.object({ version: z.string(), createdAt: z.number().optional() })),
  nextCursor: z.string().nullable().optional(),
});

export const ClawHubAmbiguousSchema = z.object({
  code: z.literal("AMBIGUOUS_SKILL_SLUG"),
  slug: z.string(),
  matches: z.array(
    z.object({
      ownerHandle: z.string(),
      slug: z.string(),
      ref: z.string().optional(),
      url: z.string().optional(),
    }),
  ),
});

const McpKeyValueSchema = z.object({
  name: z.string().optional(),
  value: z.string().optional(),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  type: z.string().optional(),
});

export const McpPackageSchema = z.object({
  registryType: z.string().optional(),
  registryBaseUrl: z.string().optional(),
  identifier: z.string().optional(),
  version: z.string().optional(),
  runtimeHint: z.string().optional(),
  transport: z.object({ type: z.string().optional(), url: z.string().optional() }).optional(),
  environmentVariables: z.array(McpKeyValueSchema).optional(),
  runtimeArguments: z.array(McpKeyValueSchema).optional(),
  packageArguments: z.array(McpKeyValueSchema).optional(),
  fileSha256: z.string().optional(),
});

export const McpRemoteSchema = z.object({
  type: z.string().optional(),
  url: z.string(),
  headers: z.array(McpKeyValueSchema).optional(),
});

export const McpServerSchema = z.object({
  $schema: z.string().optional(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  title: z.string().optional(),
  websiteUrl: z.string().optional(),
  repository: z
    .object({ url: z.string(), source: z.string().optional(), subfolder: z.string().optional() })
    .optional(),
  packages: z.array(McpPackageSchema).optional(),
  remotes: z.array(McpRemoteSchema).optional(),
});

export const McpRegistryMetaSchema = z.object({
  status: z.string().optional(),
  isLatest: z.boolean().optional(),
  publishedAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const McpServerEnvelopeSchema = z.object({
  server: McpServerSchema,
  _meta: z.record(z.string(), z.unknown()).optional(),
});

export const McpVersionListSchema = z.object({
  servers: z.array(McpServerEnvelopeSchema),
  metadata: z.object({ count: z.number().optional(), nextCursor: z.string().optional() }).optional(),
});

export const GitHubCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  commit: z
    .object({
      committer: z.object({ date: z.string().optional() }).optional(),
    })
    .optional(),
});

export const GitHubTreeEntrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  sha: z.string(),
  size: z.number().int().nonnegative().optional(),
});

export const GitHubTreeSchema = z.object({
  sha: z.string(),
  tree: z.array(GitHubTreeEntrySchema),
  truncated: z.boolean().optional(),
});

export const GitHubRepoSchema = z.object({
  default_branch: z.string(),
  full_name: z.string().optional(),
});

export const GitHubBlobSchema = z.object({
  content: z.string(),
  encoding: z.string(),
  sha: z.string(),
});

export type McpServer = z.infer<typeof McpServerSchema>;
export type GitHubTreeEntry = z.infer<typeof GitHubTreeEntrySchema>;

/* ------------------------------------------------------------------ */
/* Lockfile                                                            */
/* ------------------------------------------------------------------ */

export const LOCKFILE_VERSION = 1;
export const SIDECAR_VERSION = 1;

export interface ResolvedSource {
  /** immutable coordinates, canonical-JSON stable */
  [key: string]: string | number | boolean | null;
}

export interface LockEntry {
  ref: string;
  kind: RefKind;
  /** false when the ref tracks a moving target (latest version, branch) */
  pinned: boolean;
  resolved: ResolvedSource;
  digest: string;
  digest_covers: DigestCoverage;
  permissions: Permissions;
  manifest_fields: Record<string, string | number | boolean | null>;
  warnings?: string[];
}

export interface Lockfile {
  lockfile_version: number;
  generator: string;
  entries: LockEntry[];
}

export interface Sidecar {
  sidecar_version: number;
  generator: string;
  generator_version: string;
  resolutions: Record<string, { resolved_at: string }>;
}

const PermissionsSchema = z.object({
  status: z.enum(["declared", "undeclared"]),
  manifest: z.string().nullable(),
  filesystem: z.array(z.string()).nullable(),
  network: z.array(z.string()).nullable(),
  secrets: z.array(z.string()).nullable(),
  exec: z.array(z.string()).nullable(),
});

const ScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const LockEntrySchema = z.object({
  ref: z.string(),
  kind: z.enum(["clawhub", "mcp", "git"]),
  pinned: z.boolean(),
  resolved: z.record(z.string(), ScalarSchema),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  digest_covers: z.enum(["file-contents", "file-manifest", "git-tree", "registry-record"]),
  permissions: PermissionsSchema,
  manifest_fields: z.record(z.string(), ScalarSchema),
  warnings: z.array(z.string()).optional(),
});

export const LockfileSchema = z.object({
  lockfile_version: z.number().int(),
  generator: z.string(),
  entries: z.array(LockEntrySchema),
});

export const SidecarSchema = z.object({
  sidecar_version: z.number().int(),
  generator: z.string(),
  generator_version: z.string(),
  resolutions: z.record(z.string(), z.object({ resolved_at: z.string() })),
});
