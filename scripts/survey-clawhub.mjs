#!/usr/bin/env node
/**
 * Measure how often the most-installed ClawHub skills actually declare what
 * they need, using skill-lock's own extractor.
 *
 * Usage: node scripts/survey-clawhub.mjs [sampleSize]
 *
 * This is the script behind the numbers quoted in the README. Re-run it to
 * check them: the registry moves, so the figures will drift.
 *
 * The scored owner per slug is the first hit from `/search?q=<slug>&mode=exact`,
 * not necessarily the slug's top-downloaded publisher: that endpoint ranks by
 * relevance, not by owner-level downloads, and exposes no such count to sort by.
 * `slug_downloads` and `owners` in each row are slug-level, not this owner's.
 *
 * `/search?mode=exact` returns a bare `{ results: [...] }` with no total or
 * pagination field, so a cap cannot be confirmed from the response shape alone;
 * see `note` in the printed output for the highest owner count this run observed.
 */
import { parseOpenClawManifest } from "../src/manifests/openclaw.ts";
import { USER_AGENT } from "../src/http.ts";

const CLAWHUB = "https://clawhub.ai/api/v1";
const sampleSize = Number(process.argv[2] ?? 40);

const get = async (url, asText = false) => {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return asText ? res.text() : res.json();
};

/**
 * The download-ranked listing is slug-level, so its "latest version" belongs to
 * whichever publisher ranks first and need not exist for the owner we picked.
 * Ask the owner-scoped record for its own latest instead.
 */
const latestVersionFor = async (slug, owner) => {
  const detail = await get(`${CLAWHUB}/skills/${encodeURIComponent(slug)}?owner=${encodeURIComponent(owner)}`);
  return detail.latestVersion?.version ?? detail.skill?.tags?.latest;
};

const top = (await get(`${CLAWHUB}/skills?limit=${sampleSize}&sort=downloads`)).items;

const stats = {
  sampled: 0,
  declares_something: 0,
  declares_nothing: 0,
  declares_a_secret: 0,
  slug_published_by_multiple_owners: 0,
  skipped: 0,
};
const rows = [];

for (const skill of top) {
  const search = await get(`${CLAWHUB}/search?q=${encodeURIComponent(skill.slug)}&mode=exact`);
  const owners = [
    ...new Set(
      (search.results ?? [])
        .filter((r) => (r.canonicalUrl ?? "").endsWith(`/skills/${skill.slug}`))
        .map((r) => r.native?.ownerHandle)
        .filter(Boolean),
    ),
  ];
  if (owners.length > 1) stats.slug_published_by_multiple_owners += 1;

  const owner = owners[0];
  if (owner === undefined) {
    stats.skipped += 1;
    continue;
  }

  let source;
  let version;
  try {
    version = await latestVersionFor(skill.slug, owner);
    source = await get(
      `${CLAWHUB}/skills/${encodeURIComponent(skill.slug)}/file?path=SKILL.md&version=${encodeURIComponent(version)}&owner=${encodeURIComponent(owner)}`,
      true,
    );
  } catch (cause) {
    stats.skipped += 1;
    rows.push({ ref: `clawhub:${owner}/${skill.slug}`, skipped: String(cause) });
    continue;
  }
  const { permissions } = parseOpenClawManifest(source, "SKILL.md");

  stats.sampled += 1;
  if (permissions.status === "declared") {
    stats.declares_something += 1;
    if ((permissions.secrets ?? []).length > 0) stats.declares_a_secret += 1;
  } else {
    stats.declares_nothing += 1;
  }
  rows.push({
    ref: `clawhub:${owner}/${skill.slug}@${version}`,
    slug_downloads: skill.stats?.downloads ?? 0,
    owners: owners.length,
    status: permissions.status,
    secrets: permissions.secrets ?? null,
  });
}

const maxOwnersObserved = Math.max(0, ...rows.map((r) => r.owners ?? 0));
const note =
  "The scored owner per slug is the first hit from /search?mode=exact, not necessarily the " +
  "slug's top-downloaded publisher. slug_downloads and owners are slug-level counts, not the " +
  "scored owner's. /search?mode=exact exposes no total/pagination field, so a hard cap on " +
  `owner counts cannot be confirmed; the highest owner count this run observed is ${maxOwnersObserved}.`;

console.log(JSON.stringify({ measured_at: new Date().toISOString(), note, stats, rows }, null, 2));
