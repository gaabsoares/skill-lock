#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { diffLockfiles } from "./diff.ts";
import {
  EXIT_DRIFT,
  EXIT_OK,
  EXIT_OPERATIONAL,
  SkillLockError,
  usageError,
} from "./errors.ts";
import {
  DEFAULT_LOCKFILE,
  emptyLockfile,
  emptySidecar,
  findEntry,
  parseLockfile,
  readLockfile,
  readSidecar,
  sidecarPathFor,
  syncSidecar,
  upsertEntry,
  writeLockfile,
  writeSidecar,
} from "./lockfile.ts";
import { parseRef } from "./ref.ts";
import {
  json,
  renderDiffMarkdown,
  renderEntryLine,
  renderEntryMarkdown,
  renderVerifyMarkdown,
} from "./report.ts";
import { resolveOptions, resolveParsed } from "./resolvers/index.ts";
import type { Lockfile } from "./schema.ts";
import { verifyExitCode, verifyLockfile } from "./verify.ts";

const VERSION = "0.1.0";

const USAGE = `skill-lock ${VERSION} - pin AI agent extensions and diff what they are allowed to do

Usage:
  skill-lock add <ref>...            resolve refs and record them in the lockfile
  skill-lock resolve <ref>           resolve one ref and print it, touching no files
  skill-lock verify                  re-resolve every locked entry and report drift
  skill-lock diff <a> <b>            diff two lockfiles
  skill-lock diff <ref>              diff a locked entry against upstream right now
  skill-lock list                    list locked entries

Reference forms:
  clawhub:<owner>/<slug>[@<version>]         ClawHub skill (owner is optional but slugs collide)
  mcp:<serverName>[@<version>]               official MCP registry server
  github.com/<owner>/<repo>[@<rev>][#<dir>]  git-hosted extension

Options:
  --lockfile <path>   lockfile to read or write (default: ${DEFAULT_LOCKFILE})
  --json              machine-readable output
  --markdown          human-readable report (default for diff and verify)
  --strict            verify also fails when an unpinned ref has moved
  --no-fetch-content  do not download ClawHub file bytes; trust the registry's hashes
  --version, --help

Exit codes:
  0 clean   1 drift or policy failure   2 operational failure (network, disk)
  3 bad input or missing upstream       4 integrity failure (refused to trust the response)
`;

interface Options {
  lockfile: string;
  json: boolean;
  markdown: boolean;
  strict: boolean;
  fetchContent: boolean;
}

function parseArgs(argv: string[]): { command: string | null; args: string[]; options: Options } {
  const options: Options = {
    lockfile: DEFAULT_LOCKFILE,
    json: false,
    markdown: false,
    strict: false,
    fetchContent: true,
  };
  const args: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--markdown":
        options.markdown = true;
        break;
      case "--strict":
        options.strict = true;
        break;
      case "--no-fetch-content":
        options.fetchContent = false;
        break;
      case "--lockfile": {
        const value = argv[i + 1];
        if (value === undefined) throw usageError("--lockfile needs a path");
        options.lockfile = value;
        i += 1;
        break;
      }
      default:
        if (arg.startsWith("--lockfile=")) {
          options.lockfile = arg.slice("--lockfile=".length);
        } else if (arg.startsWith("-")) {
          throw usageError(`unknown option "${arg}"`, "Run `skill-lock --help` for the option list.");
        } else if (command === null) {
          command = arg;
        } else {
          args.push(arg);
        }
    }
  }
  return { command, args, options };
}

const nowIso = () => new Date().toISOString();

async function loadOrEmptyLockfile(path: string): Promise<Lockfile> {
  try {
    return await readLockfile(path);
  } catch (cause) {
    if (cause instanceof SkillLockError && cause.message.startsWith("no lockfile at")) {
      return emptyLockfile();
    }
    throw cause;
  }
}

async function commandAdd(refs: string[], options: Options): Promise<number> {
  if (refs.length === 0) throw usageError("`add` needs at least one reference");

  let lock = await loadOrEmptyLockfile(options.lockfile);
  const sidecarPath = sidecarPathFor(options.lockfile);
  const sidecar = await readSidecar(sidecarPath).catch(() => emptySidecar());
  const touched = new Map<string, string>();
  const added = [];

  for (const raw of refs) {
    const entry = await resolveParsed(parseRef(raw), resolveOptions({ fetchContent: options.fetchContent }));
    lock = upsertEntry(lock, entry);
    touched.set(entry.ref, nowIso());
    added.push(entry);
  }

  await writeLockfile(options.lockfile, lock);
  await writeSidecar(sidecarPath, syncSidecar(sidecar, lock, touched));

  if (options.json) {
    process.stdout.write(json({ lockfile: options.lockfile, added }));
  } else {
    for (const entry of added) process.stdout.write(`${renderEntryLine(entry)}\n`);
    const count = lock.entries.length;
    process.stdout.write(
      `\nwrote ${options.lockfile} (${count} ${count === 1 ? "entry" : "entries"}) and ${sidecarPath}\n`,
    );
  }
  return EXIT_OK;
}

async function commandResolve(refs: string[], options: Options): Promise<number> {
  if (refs.length !== 1) throw usageError("`resolve` takes exactly one reference");
  const entry = await resolveParsed(
    parseRef(refs[0]!),
    resolveOptions({ fetchContent: options.fetchContent }),
  );
  process.stdout.write(options.json ? json(entry) : renderEntryMarkdown(entry));
  return EXIT_OK;
}

async function commandVerify(options: Options): Promise<number> {
  const lock = await readLockfile(options.lockfile);
  const report = await verifyLockfile(lock, resolveOptions({ fetchContent: options.fetchContent }));
  process.stdout.write(options.json ? json(report) : renderVerifyMarkdown(report));
  return verifyExitCode(report, options.strict);
}

async function commandDiff(args: string[], options: Options): Promise<number> {
  let report;

  if (args.length === 2) {
    const [pathA, pathB] = args as [string, string];
    const [a, b] = await Promise.all([
      readFile(pathA, "utf8").then((t) => parseLockfile(t, pathA)),
      readFile(pathB, "utf8").then((t) => parseLockfile(t, pathB)),
    ]);
    report = diffLockfiles(a, b, { from: pathA, to: pathB });
  } else if (args.length === 1) {
    const lock = await readLockfile(options.lockfile);
    const ref = parseRef(args[0]!);
    const locked = findEntry(lock, ref.canonical);
    if (locked === undefined) {
      throw usageError(
        `"${ref.canonical}" is not in ${options.lockfile}`,
        `Locked refs: ${lock.entries.map((e) => e.ref).join(", ") || "(none)"}`,
      );
    }
    const fresh = await resolveParsed(ref, resolveOptions({ fetchContent: options.fetchContent }));
    report = diffLockfiles(
      { ...lock, entries: [locked] },
      { ...lock, entries: [fresh] },
      { from: `${options.lockfile}`, to: "upstream now" },
    );
  } else {
    throw usageError("`diff` takes either two lockfile paths or one locked reference");
  }

  process.stdout.write(options.json ? json(report) : renderDiffMarkdown(report));
  return report.summary.high_severity > 0 ? EXIT_DRIFT : EXIT_OK;
}

async function commandList(options: Options): Promise<number> {
  const lock = await readLockfile(options.lockfile);
  if (options.json) {
    process.stdout.write(json(lock));
  } else if (lock.entries.length === 0) {
    process.stdout.write(`${options.lockfile} has no entries\n`);
  } else {
    for (const entry of lock.entries) process.stdout.write(`${renderEntryLine(entry)}\n`);
  }
  return EXIT_OK;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }

  const { command, args, options } = parseArgs(argv);

  switch (command) {
    case "add":
      return commandAdd(args, options);
    case "resolve":
      return commandResolve(args, options);
    case "verify":
      return commandVerify(options);
    case "diff":
      return commandDiff(args, options);
    case "list":
      return commandList(options);
    case null:
      throw usageError("no command given", "Run `skill-lock --help`.");
    default:
      throw usageError(`unknown command "${command}"`, "Run `skill-lock --help`.");
  }
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url.startsWith("file:");

if (isEntrypoint) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (cause) {
    if (cause instanceof SkillLockError) {
      process.stderr.write(`skill-lock: ${cause.message}\n`);
      if (Object.keys(cause.detail).length > 0) {
        process.stderr.write(`${JSON.stringify(cause.detail, null, 2)}\n`);
      }
      if (cause.hint !== undefined) process.stderr.write(`hint: ${cause.hint}\n`);
      process.exitCode = cause.exitCode;
    } else {
      process.stderr.write(`skill-lock: unexpected failure: ${(cause as Error).stack ?? String(cause)}\n`);
      process.exitCode = EXIT_OPERATIONAL;
    }
  }
}
