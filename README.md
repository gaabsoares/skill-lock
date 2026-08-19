# skill-lock

Pin AI agent extensions to an immutable source and content digest, and diff what they are allowed to do between versions.

Works across three ecosystems with one data model: ClawHub skills, official MCP registry servers, and git-hosted extensions.

## The problem

Agent extensions get installed the way npm packages were installed in 2010.

A skill or MCP server is usually added by name. The name resolves to whatever the registry serves today. The extension then runs inside an agent that holds shell access, repository write access, and API credentials. Between the version you reviewed and the version you are running:

- the package can be republished under the same name;
- the publisher behind a name can change;
- a new release can start demanding a credential it never asked for before, and nothing in the install flow says so;
- the same short name can belong to several different publishers.

That last one is not hypothetical. In a sample of the 40 most-downloaded ClawHub slugs (measured 2026-08-19, see `measured_at` in the survey JSON), **30 slugs are published by more than one owner**. Which publisher a bare slug resolves to is decided by the registry's ranking, not by anything you typed; the CLI reference itself now documents the owner-scoped form. skill-lock refuses to guess.

And the permission metadata that would let you review a change is mostly absent. In that same sample of 40 (measured 2026-08-19), **22 declare nothing at all** about what they need, and only 5 declare a credential. Absence often means the skill predates the field, not that the author hid anything, which is exactly why "undeclared" is modelled as unknown, not as empty. Reproduce both numbers with `node scripts/survey-clawhub.mjs 40` (output committed at [`examples/clawhub-survey.json`](examples/clawhub-survey.json)).

skill-lock does not fix the metadata gap. It records exactly what is and is not declared, pins the bytes, and tells you when either changes.

## Install and use

```sh
npx @gaabsoares/skill-lock add clawhub:conorkenn/openclaw-github-assistant@1.0.1
npx @gaabsoares/skill-lock add mcp:io.github.brave/brave-search-mcp-server@2.1.0
npx @gaabsoares/skill-lock verify
npx @gaabsoares/skill-lock diff agents.lock other.lock
```

`add` writes `agents.lock`. Commit it. `verify` re-resolves every entry and exits non-zero on drift, which is the CI seam.

## The diff that matters

Real example, reproducible today. The ClawHub skill `conorkenn/openclaw-github-assistant` went from 1.0.1 to 1.0.2. Between those versions the manifest went from declaring nothing to declaring four credential requirements: the token was already needed in 1.0.1 (the SKILL.md prose said so), but only in 1.0.2 does the manifest say it. skill-lock reads manifests, not prose, so this is exactly what it should surface: the extension's stated capabilities changed, and a reviewer should look.

```sh
skill-lock add --lockfile before.lock clawhub:conorkenn/openclaw-github-assistant@1.0.1
skill-lock add --lockfile after.lock  clawhub:conorkenn/openclaw-github-assistant@1.0.2
skill-lock diff before.lock after.lock
```

```
## Permission additions (4)

New capability an extension did not previously declare. Review before accepting the update.

| Extension | Axis | Added |
| --- | --- | --- |
| `clawhub:conorkenn/openclaw-github-assistant@1.0.2` | secrets | `config:github.token` |
| `clawhub:conorkenn/openclaw-github-assistant@1.0.2` | secrets | `config:github.username` |
| `clawhub:conorkenn/openclaw-github-assistant@1.0.2` | secrets | `env:GITHUB_TOKEN` |
| `clawhub:conorkenn/openclaw-github-assistant@1.0.2` | secrets | `env:GITHUB_USERNAME` |
```

Exit code 1. Full output, including the digest and manifest changes, is committed at [`examples/permission-diff/`](examples/permission-diff/) in both Markdown and JSON.

Worth noting what skill-lock reports for 1.0.1: **undeclared**. The body of that version's `SKILL.md` already told the reader to set `GITHUB_TOKEN`, but its manifest declared nothing. skill-lock reads manifests, not prose. It will not turn a sentence into a permission, so "undeclared" here is the honest answer and the 1.0.2 declaration is a real change in what the extension states about itself.

That is the good outcome here: the author declared what was already true instead of leaving it silent, and skill-lock's job is to make that kind of change visible, not to punish it.

## Reference forms

```
clawhub:<owner>/<slug>[@<version>]          ClawHub skill
mcp:<serverName>[@<version>]                official MCP registry server
github.com/<owner>/<repo>[@<rev>][#<dir>]   git-hosted extension
```

The ClawHub owner is optional, but a bare slug that several owners publish is rejected with the list of candidates rather than resolved to a guess:

```
skill-lock: ClawHub slug "self-improving-agent" is published by 6 different owners
hint: Pin the owner: clawhub:pskoett/self-improving-agent, clawhub:jianghg01/self-improving-agent, ...
```

Web URLs work too and normalise to the same canonical ref (`https://clawhub.ai/<owner>/skills/<slug>`, a registry `/v0.1/servers/...` URL, `git+https://github.com/...`).

## What a lock entry looks like

```json
{
  "ref": "clawhub:uroboros1205/prismfy-search@1.3.8",
  "kind": "clawhub",
  "pinned": true,
  "resolved": {
    "api_url": "https://clawhub.ai/api/v1/skills/prismfy-search/versions/1.3.8?owner=uroboros1205",
    "owner": "uroboros1205",
    "registry": "clawhub.ai",
    "slug": "prismfy-search",
    "url": "https://clawhub.ai/uroboros1205/skills/prismfy-search",
    "version": "1.3.8"
  },
  "digest": "sha256:891e8f61327799dfe8acf0b1a42b2a8a16eb7be6495b9b975867069a66062a41",
  "digest_covers": "file-contents",
  "permissions": {
    "status": "declared",
    "manifest": "SKILL.md:metadata.openclaw",
    "filesystem": null,
    "network": null,
    "secrets": ["env:PRISMFY_API_KEY"],
    "exec": ["bin:curl", "bin:jq"]
  },
  "manifest_fields": { "...": "..." }
}
```

Six real extensions across all three ecosystems are locked in [`examples/agents.lock`](examples/agents.lock).

### The permission model

Four axes, one shape for every ecosystem: `filesystem`, `network`, `secrets`, `exec`.

`null` on an axis means **undeclared**: the format has no field for it, or the manifest left it out. `[]` means the field exists and is empty. That distinction is the point. An extension that declares no network access and one whose format cannot express network access are different situations, and collapsing them into "no permissions" would be the lie this tool exists to avoid.

Values are `type:identifier` strings, so a change of kind shows up as a removal plus an addition rather than an invisible flag flip. An environment variable that becomes a secret reads as `-env:TOKEN` and `+secret:TOKEN`.

Nothing is inferred. skill-lock reads `metadata.openclaw` (and the pre-rename `metadata.clawdbot`) from a skill's frontmatter, `allowed-tools` where present, and the MCP registry's `packages` and `remotes` records. Anything else is `undeclared`. It never reads code or prose to guess capability.

Note one consequence: for MCP registry servers, `filesystem` is always `null`. The server schema has no field for filesystem scope. A filesystem MCP server and a weather one look identical on that axis, because the format cannot tell them apart.

### What the digest covers

`digest_covers` is recorded per entry so nobody has to guess how much trust the digest carries.

| Value | What was hashed | Trust anchor |
| --- | --- | --- |
| `file-contents` | every file downloaded and hashed by skill-lock, cross-checked against the registry's declared hash | our own bytes |
| `file-manifest` | the registry's per-file hashes, under `--no-fetch-content` | the registry |
| `git-tree` | paths, modes and git blob object ids for the tree or subdirectory | GitHub's blob hashes (SHA-1) |
| `registry-record` | the registry's immutable version record, timestamps stripped | the registry, plus npm/PyPI/OCI immutability for the package it names |

For ClawHub, a downloaded file whose hash does not match the registry's declared hash is an integrity failure and stops the run.

The two file-based coverages produce different digests for identical inputs, on purpose: a hash you took on trust must never compare equal to one you verified.

### Determinism

`agents.lock` is byte-identical across runs when nothing upstream changed: entries sorted by ref, fixed key order at every level, and no timestamps anywhere. Timestamps live in the sidecar `agents.lock.meta.json`, which is never a digest input, so `git diff` on the lockfile only ever shows real changes.

This is verified two ways: a test asserts byte-identical serialisation under shuffled insertion order, and the committed `examples/agents.lock` was generated twice against the live APIs and compared.

## In CI

```yaml
- run: npx @gaabsoares/skill-lock verify --strict
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | clean |
| 1 | drift, or a diff containing high-severity changes |
| 2 | operational failure: network unreachable, rate limited, disk |
| 3 | bad input, or upstream says the ref does not exist |
| 4 | integrity failure: skill-lock refused to trust the response |

`verify` separates two things that look alike. A **pinned** ref whose content changed is drift and fails. An **unpinned** ref that moved is an update, which passes unless you pass `--strict`. A publisher or repository changing underneath any ref is drift either way. Only a full 40-character commit SHA counts as pinned for git refs, because branches and tags move.

Codes 1 and 2 are deliberately distinct: a failing network must never look like a clean run, and it must never look like drift either.

## What this does not do

Stated plainly, because a security tool that overstates its scope is worse than none.

- **No malware scanning.** It does not look for malicious code, obfuscation, or prompt injection. A pinned extension can be malicious.
- **No policy engine.** There is no allow/deny configuration. It reports; you decide.
- **No registry or curation.** It publishes no trust list and rates nobody.
- **No runtime monitoring.** It says nothing about what an extension does once running, only what it declared and what its bytes were.
- **No signature verification.** Provenance here means "this is the same artifact", not "this publisher is who they claim".
- **No transitive dependencies.** A skill's npm dependencies are outside the digest. The digest covers the extension's own files.
- **github.com only** for git refs. Other hosts are refused by name rather than half-supported.

Roadmap ideas, none of them promises: signed local attestations; policy-as-code with an org allow list; a GitHub Action wrapping `verify`; SBOM export; declared-versus-observed capability diffing; runtime manifest and schema drift for locked MCP servers.

## How it compares

**Against ClawHub and the MCP registry.** Both already do things skill-lock depends on rather than duplicates. ClawHub publishes per-file SHA-256 hashes, immutable versions, and its own security scanning; the MCP registry publishes immutable version records with structured environment-variable metadata including an `isSecret` flag. skill-lock's contribution is the layer above: it takes a snapshot across all of them in one file you commit, verifies ClawHub's declared hashes against the bytes rather than trusting them, and answers a question neither registry answers, which is what changed between the version you reviewed and the one you are about to run. If either registry ships cross-ecosystem lockfiles with permission diffing, this tool has served its purpose and should be retired.

**Against Snyk Agent Scan.** Different jobs, and they compose. Snyk Agent Scan looks inside an extension for malicious and vulnerable patterns: it answers "is this thing bad?". skill-lock answers "is this the same thing I reviewed, and does it now want more?". A scanner that passes an extension today says nothing about the version that gets pulled tomorrow; a lockfile that pins that version says nothing about whether it was malicious when pinned. Running both is strictly better than running either. If you can only run one and you have never reviewed your extensions, run the scanner first.

**Related.** `luisalima/skills-lock` is a separate, unaffiliated project with a similar name (pinned commits and content hashes for agent skills). [`skilllock`](https://www.npmjs.com/package/skilllock) on npm (May 2026) is another unaffiliated project in the same space (reproducible lockfiles and verification for Agent Skills); it predates this tool and is why this package publishes under a scope.

## Rate limits

All three upstreams are used unauthenticated. Observed at the time of writing:

- **ClawHub**: 3000 reads per minute per IP. Generous. A ClawHub skill costs roughly 2 requests plus one per file, since file bytes are downloaded and hashed.
- **MCP registry**: no documented limit encountered. One or two requests per server.
- **GitHub**: **60 requests per hour** unauthenticated, which is the real constraint. A git ref costs 2 to 4 requests, so roughly 15 to 30 git refs per hour. skill-lock reads `Retry-After` and `X-RateLimit-Reset`, retries once, then fails with exit code 2 and the reset time rather than resolving partially.

Rate limiting is never silently swallowed. A run that could not check something says so and exits non-zero.

## Development

```sh
npm install
npm test          # 106 tests, fully offline
npm run typecheck
npm run build
```

Tests run against recorded real API responses in `test/fixtures/`, so the suite never touches the network. Re-record them with `node scripts/record-fixtures.mjs <ref>...` when an upstream shape changes. Fixtures are recorded verbatim and never hand-edited.

Two runtime dependencies, zero transitive: `zod` validates upstream payloads so that a changed API shape fails loudly instead of producing a meaningless digest, and `yaml` parses skill frontmatter, because mis-parsing a declared permission is a worse outcome than a dependency.

## Requirements

Node 22.18 or newer.

## License

MIT
