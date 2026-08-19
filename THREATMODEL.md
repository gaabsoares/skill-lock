# Threat model

What pinning an agent extension actually buys, and what it does not. Read the second list before relying on the first.

## Assets

An agent extension runs inside a process that typically holds shell access, repository write access, cloud and API credentials from the environment, and the ability to make outbound network requests. An extension is not a library; it is closer to a shell script you agreed to run continuously. That is what makes a silent change to one worth detecting.

## What skill-lock defeats

### Silent republish under a fixed name

An extension is pinned to `foo@1.2.3`. The publisher later pushes different content under that same version, or the registry serves different bytes for it.

`verify` re-resolves the pinned ref and compares the digest. A mismatch on a pinned ref is reported as `pinned_digest_changed` at high severity and exits 1. This is the single strongest guarantee here: for ClawHub, the comparison is against bytes skill-lock downloaded and hashed itself, not against a hash the registry asserted.

### Permission creep across an update

A version you reviewed declared nothing. The next one demands `GITHUB_TOKEN`. Nothing in a normal install flow surfaces that.

`diff` reports every added capability at high severity and leads the report with them. This is the headline case, and the README demo is a real occurrence of a declaration change surfaced by `diff`, not a constructed one. skill-lock cannot tell creep from catch-up here; that judgment is the reviewer's job.

### An extension quietly dropping its declarations

Removing a `requires` block would make an extension look harmless if "no declaration" were treated as "no permissions". skill-lock models undeclared as `null`, distinct from an empty list, and reports an axis that stops being declared as `permission_no_longer_declared` at medium severity: capability became unknown, not absent.

### Publisher substitution under a name you locked

The owner behind a ClawHub slug or the repository behind a git ref changes. Identity fields are compared separately from version fields, so a changed owner, slug, registry, host or repo is `source_moved` at high severity, and it counts as drift even for unpinned refs where a version change would not.

### Namespace collision and typosquatting by ambiguity

30 of the 40 most-downloaded ClawHub slugs are published by more than one owner. Resolving a bare slug to the most popular match would silently pick a publisher for you. skill-lock refuses, listing every candidate. It does not detect typosquatting (a name deliberately similar to another); it removes the ambiguity of an exactly-equal name.

### Partial or misunderstood upstream data being written into a lockfile

A truncated git tree, an unparseable response, an API whose shape changed, or a file whose bytes do not match the registry's declared hash all stop the run with a non-zero exit. A lockfile entry is never written from data skill-lock only partly understood, because a digest over a misread response is worse than no digest: it looks like evidence.

## What skill-lock does not defeat

### Compromised at pin time

If an extension is already malicious when you lock it, skill-lock pins the malicious version faithfully and reports it clean forever. It verifies sameness, never safety. Use a scanner (Snyk Agent Scan and similar) and human review for the initial decision. This is the most important limitation on the page.

### Malicious but honestly declared

An extension that declares `env:AWS_SECRET_ACCESS_KEY` and exfiltrates it is fully compliant with this tool. The declaration is reported; the intent is not judged. Reviewing whether a declared capability is *appropriate* is a human job that skill-lock only supplies input for.

### Permission creep versus declaration catch-up

skill-lock cannot distinguish an extension that started requiring something it did not need before from one that started declaring something it always needed. Surfacing the change for a reviewer to judge is the entire claim; the judgment itself stays a human one.

### Behaviour that never appears in a manifest

Declared permissions are self-reported. An extension can declare nothing and still read files, spawn processes, and make network calls. Given that 22 of 40 sampled slugs declare nothing at all, this is the common case, not the corner case. A clean skill-lock report on an undeclared extension means "unchanged and unknown", never "safe". The tool prints exactly that wording for a reason.

### Transitive dependencies

The digest covers an extension's own files. A skill whose `package.json` pulls a compromised npm package will show an unchanged digest. For MCP registry entries the digest covers the registry record, which names a package rather than containing it: immutability there rests on npm, PyPI or the OCI registry, not on skill-lock.

### A compromised registry or a compromised GitHub

skill-lock talks to ClawHub, the MCP registry, and the GitHub API over TLS with no additional verification. A registry that serves consistent malicious content, or an attacker who controls those responses, defeats both the pin and the verification. There is no signature checking and no publisher identity verification in 0.1.

### Weaknesses inherited from git object hashing

Git tree digests are built from git blob object ids, which are SHA-1. SHA-1 is not collision resistant. A crafted collision could in principle leave a git-tree digest unchanged across different content. This is a known and accepted weakness of the `git-tree` coverage mode; ClawHub entries use SHA-256 over bytes we downloaded and do not have it.

### The lockfile itself

`agents.lock` is an unsigned plain file. Anyone who can edit your repository can edit it. It is a review artifact for a trusted repository, not a tamper-proof record. Protect it the way you protect any other committed CI configuration.

### Time-of-check to time-of-use

`verify` proves what upstream served at the moment it ran. It does not install anything and does not sit between the registry and your agent. A registry can serve different bytes to the install step than it served to `verify`.

## Assumed trust

Using skill-lock means trusting: TLS and the certificate authorities; ClawHub, the MCP registry, and GitHub to serve the same content to you as to everyone else; npm, PyPI and OCI registries to keep published versions immutable; the machine running the tool; and this tool's two dependencies, `zod` and `yaml`.

## Reporting

Security issues in skill-lock itself: use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), not a public issue. This is a personal project with no SLA, and it should not be the only control in a security programme.
