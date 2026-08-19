import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unreachable } from "../src/errors.ts";
import type { Fetcher, HttpResponse } from "../src/http.ts";
import { resolveOptions, type ResolveOptions } from "../src/resolvers/index.ts";
import type { LockEntry } from "../src/schema.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");

interface Exchange {
  url: string;
  status: number;
  body: string;
}

export const exchanges: Exchange[] = JSON.parse(
  readFileSync(join(FIXTURES, "http.json"), "utf8"),
) as Exchange[];

export const expected: { refs: string[]; entries: LockEntry[] } = JSON.parse(
  readFileSync(join(FIXTURES, "expected-entries.json"), "utf8"),
) as { refs: string[]; entries: LockEntry[] };

export interface FixtureFetcherHandle {
  fetch: Fetcher;
  calls: string[];
}

/**
 * Serves the recorded exchanges and nothing else. An unrecorded URL is a test
 * failure rather than a live request, so the suite can never quietly depend on
 * the network.
 */
export function fixtureFetcher(overrides: Record<string, Partial<Exchange>> = {}): FixtureFetcherHandle {
  const byUrl = new Map(exchanges.map((e) => [e.url, e]));
  const calls: string[] = [];

  const fetch: Fetcher = async (url) => {
    calls.push(url);
    const override = overrides[url];
    if (override !== undefined && override.status === 0) {
      throw unreachable(`cannot reach ${url}: simulated network failure`);
    }
    const base = byUrl.get(url);
    if (base === undefined && override === undefined) {
      throw new Error(`no fixture recorded for ${url}`);
    }
    const merged = { ...(base ?? { url, status: 200, body: "" }), ...override };
    return {
      url,
      status: merged.status,
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode(merged.body),
    } satisfies HttpResponse;
  };

  return { fetch, calls };
}

export function offlineOptions(overrides: Record<string, Partial<Exchange>> = {}): ResolveOptions {
  return resolveOptions({ fetch: fixtureFetcher(overrides).fetch });
}

export function entryFor(refFragment: string): LockEntry {
  const entry = expected.entries.find((e) => e.ref.includes(refFragment));
  if (entry === undefined) throw new Error(`no recorded entry matching "${refFragment}"`);
  return structuredClone(entry);
}
