/**
 * Error taxonomy. Every failure in skill-lock is one of these kinds, and each
 * kind maps to a stable process exit code so CI can branch on the reason.
 */

export type ErrorKind =
  | "invalid-ref"
  | "ambiguous-ref"
  | "not-found"
  | "unreachable"
  | "rate-limited"
  | "upstream-shape"
  | "integrity"
  | "lockfile"
  | "usage";

export const EXIT_OK = 0;
/** verify/diff found something the operator must act on */
export const EXIT_DRIFT = 1;
/** transient or environmental: network unreachable, rate limited, disk */
export const EXIT_OPERATIONAL = 2;
/** the operator gave us something we cannot use, or upstream says it does not exist */
export const EXIT_INPUT = 3;
/** we reached upstream but refuse to trust what came back */
export const EXIT_INTEGRITY = 4;

export function exitCodeFor(kind: ErrorKind): number {
  switch (kind) {
    case "unreachable":
    case "rate-limited":
      return EXIT_OPERATIONAL;
    case "invalid-ref":
    case "ambiguous-ref":
    case "not-found":
    case "usage":
    case "lockfile":
      return EXIT_INPUT;
    case "upstream-shape":
    case "integrity":
      return EXIT_INTEGRITY;
  }
}

export class SkillLockError extends Error {
  readonly kind: ErrorKind;
  readonly detail: Record<string, unknown>;
  readonly hint: string | undefined;

  constructor(
    kind: ErrorKind,
    message: string,
    options?: { detail?: Record<string, unknown>; hint?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SkillLockError";
    this.kind = kind;
    this.detail = options?.detail ?? {};
    this.hint = options?.hint;
  }

  get exitCode(): number {
    return exitCodeFor(this.kind);
  }
}

export const invalidRef = (message: string, hint?: string) =>
  new SkillLockError("invalid-ref", message, hint === undefined ? undefined : { hint });

export const ambiguousRef = (message: string, detail: Record<string, unknown>, hint: string) =>
  new SkillLockError("ambiguous-ref", message, { detail, hint });

export const notFound = (message: string, detail?: Record<string, unknown>) =>
  new SkillLockError("not-found", message, detail === undefined ? undefined : { detail });

export const unreachable = (message: string, cause?: unknown) =>
  new SkillLockError("unreachable", message, { cause });

export const rateLimited = (message: string, detail: Record<string, unknown>) =>
  new SkillLockError("rate-limited", message, { detail });

export const upstreamShape = (message: string, detail: Record<string, unknown>) =>
  new SkillLockError("upstream-shape", message, {
    detail,
    hint: "The upstream API returned a shape skill-lock does not recognise. This is a fail-loud stop, not a skip: pinning against a half-understood response would produce a digest that means nothing.",
  });

export const integrity = (message: string, detail: Record<string, unknown>) =>
  new SkillLockError("integrity", message, { detail });

export const lockfileError = (message: string, hint?: string) =>
  new SkillLockError("lockfile", message, hint === undefined ? undefined : { hint });

export const usageError = (message: string, hint?: string) =>
  new SkillLockError("usage", message, hint === undefined ? undefined : { hint });
