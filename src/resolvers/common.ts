import type { z } from "zod";
import { upstreamShape } from "../errors.ts";
import { httpGet, type Fetcher } from "../http.ts";
import type { LockEntry } from "../schema.ts";
import type { ParsedRef } from "../ref.ts";

export const CLAWHUB_BASE = "https://clawhub.ai/api/v1";
export const MCP_BASE = "https://registry.modelcontextprotocol.io/v0.1";
export const GITHUB_API_BASE = "https://api.github.com";

export interface ResolveOptions {
  fetch: Fetcher;
  clawhubBase: string;
  mcpBase: string;
  githubApiBase: string;
  /**
   * When false, ClawHub file bytes are not downloaded and the registry's own
   * per-file hashes are recorded instead. The lockfile says which happened via
   * `digest_covers`, so a trusted-hash entry can never be mistaken for a
   * verified one.
   */
  fetchContent: boolean;
}

export function resolveOptions(overrides: Partial<ResolveOptions> = {}): ResolveOptions {
  return {
    fetch: httpGet,
    clawhubBase: CLAWHUB_BASE,
    mcpBase: MCP_BASE,
    githubApiBase: GITHUB_API_BASE,
    fetchContent: true,
    ...overrides,
  };
}

export interface Resolution {
  entry: LockEntry;
  resolvedAt: string;
}

export type Resolver = (ref: ParsedRef, options: ResolveOptions) => Promise<LockEntry>;

/** Validate an upstream payload, turning any shape drift into a fail-loud stop. */
export function parseWith<T>(schema: z.ZodType<T>, data: unknown, what: string, url: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 6).map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  throw upstreamShape(`${what} did not match the shape skill-lock expects`, { url, issues });
}

export function sortedByPath<T extends { path: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
