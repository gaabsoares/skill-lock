export { canonicalJson, computeDigest, sha256Hex, sha256Of, DIGEST_ALGORITHM } from "./canonical.ts";
export type { DigestCoverage, DigestInput, JsonValue } from "./canonical.ts";

export { SkillLockError, exitCodeFor } from "./errors.ts";
export type { ErrorKind } from "./errors.ts";

export { parseRef } from "./ref.ts";
export type { ParsedRef, RefKind } from "./ref.ts";

export { AXES, PermissionBuilder, countDeclared, undeclared } from "./permissions.ts";
export type { Axis, Permissions } from "./permissions.ts";

export { resolve, resolveParsed, resolveOptions } from "./resolvers/index.ts";
export type { ResolveOptions } from "./resolvers/index.ts";

export {
  DEFAULT_LOCKFILE,
  emptyLockfile,
  parseLockfile,
  readLockfile,
  serializeLockfile,
  upsertEntry,
  writeLockfile,
} from "./lockfile.ts";

export { diffEntries, diffLockfiles, permissionAdditions } from "./diff.ts";
export type { Change, ChangeType, DiffReport, EntryDiff, Severity } from "./diff.ts";

export { verifyEntry, verifyExitCode, verifyLockfile } from "./verify.ts";
export type { VerifyFinding, VerifyReport } from "./verify.ts";

export { renderDiffMarkdown, renderEntryMarkdown, renderVerifyMarkdown } from "./report.ts";

export type { LockEntry, Lockfile, Sidecar } from "./schema.ts";
