import { parseRef, type ParsedRef } from "../ref.ts";
import type { LockEntry } from "../schema.ts";
import { resolveOptions, type ResolveOptions } from "./common.ts";
import { resolveClawHub } from "./clawhub.ts";
import { resolveGit } from "./git.ts";
import { resolveMcp } from "./mcp.ts";

export { resolveOptions, CLAWHUB_BASE, MCP_BASE, GITHUB_API_BASE } from "./common.ts";
export type { ResolveOptions } from "./common.ts";

export async function resolveParsed(ref: ParsedRef, options: ResolveOptions): Promise<LockEntry> {
  switch (ref.kind) {
    case "clawhub":
      return resolveClawHub(ref, options);
    case "mcp":
      return resolveMcp(ref, options);
    case "git":
      return resolveGit(ref, options);
  }
}

export async function resolve(raw: string, options?: Partial<ResolveOptions>): Promise<LockEntry> {
  return resolveParsed(parseRef(raw), resolveOptions(options));
}
