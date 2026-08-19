#!/usr/bin/env node
/**
 * Record real upstream responses so the test suite runs offline.
 *
 * Usage: node scripts/record-fixtures.mjs [ref...]
 * With no arguments it records the default fixture set used by the tests.
 *
 * Every response is stored verbatim. Nothing here is hand-edited: if a fixture
 * needs to change, re-record it so the tests keep describing reality.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRef } from "../src/ref.ts";
import { resolveOptions, resolveParsed } from "../src/resolvers/index.ts";
import { httpGet } from "../src/http.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "test", "fixtures");

const DEFAULT_REFS = [
  "clawhub:nextfrontierbuilds/elite-longterm-memory@0.1.0",
  "clawhub:nextfrontierbuilds/elite-longterm-memory@1.2.3",
  "clawhub:uroboros1205/prismfy-search@1.3.8",
  process.env["SKILL_LOCK_FIXTURE_MCP"] ?? "mcp:io.github.domdomegg/airtable-mcp-server",
  process.env["SKILL_LOCK_FIXTURE_GIT"] ?? "github.com/modelcontextprotocol/servers#src/filesystem",
];

const recorded = new Map();

const recordingFetch = async (url, options) => {
  const response = await httpGet(url, options);
  recorded.set(url, {
    url,
    status: response.status,
    body: Buffer.from(response.body).toString("utf8"),
  });
  return response;
};

const refs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_REFS;
const entries = [];

for (const ref of refs) {
  process.stderr.write(`recording ${ref}\n`);
  const entry = await resolveParsed(parseRef(ref), resolveOptions({ fetch: recordingFetch }));
  entries.push(entry);
  process.stderr.write(`  digest ${entry.digest}\n`);
}

await mkdir(OUT, { recursive: true });

const exchanges = [...recorded.values()].sort((a, b) => (a.url < b.url ? -1 : 1));
await writeFile(join(OUT, "http.json"), `${JSON.stringify(exchanges, null, 2)}\n`, "utf8");
await writeFile(
  join(OUT, "expected-entries.json"),
  `${JSON.stringify({ refs, entries }, null, 2)}\n`,
  "utf8",
);

process.stderr.write(`\nwrote ${exchanges.length} exchanges for ${entries.length} refs to test/fixtures/\n`);
