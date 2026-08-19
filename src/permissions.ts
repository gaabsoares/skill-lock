import { canonicalJson, toJson } from "./canonical.ts";

export const AXES = ["filesystem", "network", "secrets", "exec"] as const;
export type Axis = (typeof AXES)[number];

/**
 * One normalised permission model across every extension format.
 *
 * `null` on an axis means the format carried no field for it: undeclared, not
 * empty. `[]` means the manifest has the field and it is empty. That
 * distinction is the whole point of the model, so nothing here ever infers a
 * capability that the manifest did not state.
 *
 * Values are `type:identifier` strings. The prefix keeps them self-describing
 * and makes a semantic change (an env var becoming a secret, say) show up as a
 * removal plus an addition rather than as an invisible flag flip.
 */
export interface Permissions {
  status: "declared" | "undeclared";
  /** where the declaration was read from, e.g. "SKILL.md:metadata.openclaw" */
  manifest: string | null;
  filesystem: string[] | null;
  network: string[] | null;
  secrets: string[] | null;
  exec: string[] | null;
}

export const UNDECLARED: Permissions = Object.freeze({
  status: "undeclared",
  manifest: null,
  filesystem: null,
  network: null,
  secrets: null,
  exec: null,
});

export function undeclared(manifest: string | null = null): Permissions {
  return { ...UNDECLARED, manifest };
}

export class PermissionBuilder {
  #values: Record<Axis, Set<string>> = {
    filesystem: new Set(),
    network: new Set(),
    secrets: new Set(),
    exec: new Set(),
  };
  #touched = new Set<Axis>();
  #warnings: string[] = [];
  readonly manifest: string;

  constructor(manifest: string) {
    this.manifest = manifest;
  }

  /** Mark an axis as declared-but-possibly-empty (the manifest field exists). */
  touch(...axes: Axis[]): this {
    for (const axis of axes) this.#touched.add(axis);
    return this;
  }

  add(axis: Axis, type: string, identifier: string | null | undefined): this {
    this.#touched.add(axis);
    if (identifier === null || identifier === undefined) return this;
    const value = String(identifier).trim();
    if (value === "") return this;
    this.#values[axis].add(`${type}:${value}`);
    return this;
  }

  /**
   * Record a value whose shape we do not recognise, rather than dropping it.
   * Hand-authored manifests are not a machine contract, so an unexpected shape
   * stays visible and diffable instead of aborting the whole resolution.
   */
  addUnrecognized(axis: Axis, field: string, value: unknown): this {
    this.#warnings.push(`${this.manifest}: unrecognised shape at ${field}`);
    return this.add(axis, "unrecognized", `${field}=${canonicalJson(toJson(value))}`);
  }

  warn(message: string): this {
    this.#warnings.push(message);
    return this;
  }

  get warnings(): string[] {
    return [...this.#warnings];
  }

  build(): Permissions {
    const axis = (a: Axis): string[] | null =>
      this.#touched.has(a) ? [...this.#values[a]].sort() : null;
    const anyTouched = this.#touched.size > 0;
    return {
      status: anyTouched ? "declared" : "undeclared",
      manifest: anyTouched ? this.manifest : null,
      filesystem: axis("filesystem"),
      network: axis("network"),
      secrets: axis("secrets"),
      exec: axis("exec"),
    };
  }
}

export function isEmpty(permissions: Permissions): boolean {
  return AXES.every((a) => permissions[a] === null || permissions[a]!.length === 0);
}

/** Total declared capability count, for one-line summaries. */
export function countDeclared(permissions: Permissions): number {
  return AXES.reduce((n, a) => n + (permissions[a]?.length ?? 0), 0);
}
