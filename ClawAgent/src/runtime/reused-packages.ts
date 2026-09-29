// Which shared cores ClawAgent composes, and what they cost in dependencies.
//
// ClawAgent resolves `@openclaw/*` from the repository checkout rather than
// installing them (see `./source-resolution.ts`), so their `package.json`
// `dependencies` never reach ClawAgent's own install. Anything those cores
// import from npm has to be declared here instead, or it is simply missing at
// runtime — on a phone, where the failure looks like a mysterious
// ERR_MODULE_NOT_FOUND deep inside a provider transport.
//
// This list is the single source of truth for both directions:
//   - `test/boundary.test.ts` reads it and fails if ClawAgent's manifest is
//     missing an external dependency that a reused core needs, or declares one
//     that no reused core does.
//   - `doctor` can report whether the cores resolve at all.
//
// Every entry must be pure JavaScript. A core that needs a native addon cannot
// be reused on Android, full stop; that is a plan-level decision, not something
// to discover at install time.
//
// Grow this list as milestones adopt cores. M1 needed provider chat; M2 adds the
// agent loop, so `agent-core` and `tool-call-repair` are now real imports rather
// than forward declarations.

import { readFileSync } from "node:fs";
import path from "node:path";

/** Shared cores ClawAgent composes from source. */
export const REUSED_PACKAGES = [
  "agent-core",
  "ai",
  "llm-core",
  "model-catalog-core",
  "normalization-core",
  "retry",
  "tool-call-repair",
] as const;

export type ReusedPackage = (typeof REUSED_PACKAGES)[number];

/**
 * Cores ClawAgent never imports directly but does load, because a reused core
 * imports them.
 *
 * `@openclaw/ai` reaches `@openclaw/media-core/base64` from its credential
 * redaction and Anthropic inline-image helpers. It has to resolve on the device
 * like any other core, so it belongs in the boundary rules even though no
 * ClawAgent file names it.
 *
 * `markdown-core` arrived at M2 the same way, and it is the more instructive of
 * the two: nothing in ClawAgent names it. `agent-core` imports
 * `@openclaw/ai/transports`, whose stream code imports `../../../markdown-core/src/reasoning-tags.js`
 * — a *relative* path into a neighbouring package, which no `exports` map records
 * and no `dependencies` block declares. It still has to resolve on the device.
 *
 * What it does NOT bring with it: media-core's own `file-type` dependency. Only
 * `base64.ts` is on this load path, and `file-type` is imported solely by
 * `mime.ts` — verified by loading `@openclaw/ai` and `@openclaw/ai/providers`
 * under the resolve hook and recording every specifier touched. Declaring it now
 * would add five packages to a phone install for code nothing calls. It arrives
 * with the milestone that actually handles attachments.
 */
export const TRANSITIVE_SOURCE_PACKAGES = ["markdown-core", "media-core"] as const;

export type TransitiveSourcePackage = (typeof TRANSITIVE_SOURCE_PACKAGES)[number];

/** Every workspace package that must resolve to source at runtime. */
export const SOURCE_LOAD_CLOSURE: readonly string[] = [
  ...REUSED_PACKAGES,
  ...TRANSITIVE_SOURCE_PACKAGES,
];

/**
 * npm packages that must be declared because the load path executes code that
 * imports them, even though no package ClawAgent names depends on them directly.
 *
 * Each entry exists because it was observed missing, not inferred from a
 * manifest. The reason names the file that imports it, so the decision can be
 * re-checked when the core changes.
 */
export const LOAD_PATH_DEPENDENCIES: Readonly<Record<string, string>> = {
  // packages/markdown-core/src/reasoning-tag-parser.ts, reached from
  // packages/ai/src/utils/reasoning-tag-text-partitioner.ts via
  // @openclaw/ai/transports, which @openclaw/agent-core imports at module scope.
  "mdast-util-from-markdown": "markdown-core parses CommonMark to find code regions",
  "mdast-util-gfm-table": "markdown-core's GFM table extension, loaded with the parser",
  "micromark-extension-gfm-table": "the micromark half of the same table support",
};

/**
 * Dependencies of a loaded package that are deliberately NOT declared.
 *
 * Recording the refusal is the point: without it, the next person to walk the
 * tree sees an "unexplained" gap and adds another five packages to a phone
 * install. Each reason says which file would need it, so the entry can be
 * deleted the day that file joins the load path.
 */
export const UNDECLARED_DEPENDENCIES: Readonly<Record<string, string>> = {
  "file-type": "only media-core/src/base64.ts is on the load path; file-type is imported by mime.ts, which is not",
  "markdown-it": "markdown-core's renderer and token pipeline; the reasoning-tag path uses mdast only",
  "markdown-it-cjk-friendly": "a markdown-it plugin, so it follows markdown-it's absence",
  yaml: "markdown-core's front-matter helpers, not reached by reasoning tags",
};

/** The scope prefix that marks a dependency as another workspace core. */
const WORKSPACE_SCOPE = "@openclaw/";

type PackageManifest = { name?: unknown; dependencies?: Record<string, string> };

function readManifest(packageDir: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

/** True when a dependency is another workspace core rather than an npm package. */
export function isWorkspaceDependency(name: string): boolean {
  return name.startsWith(WORKSPACE_SCOPE);
}

/** One reused core and the npm packages it needs. */
export type ReusedPackageRequirements = {
  package: ReusedPackage;
  /** Present in the checkout. */
  found: boolean;
  /** npm dependencies, excluding other `@openclaw/*` cores. */
  externalDependencies: Record<string, string>;
};

/**
 * Reads what each reused core needs from npm.
 *
 * Returns an entry even for a core that is missing from the checkout, so a
 * renamed or removed package shows up as a diagnosable gap rather than as a
 * silently shorter requirement list.
 */
export function readReusedPackageRequirements(
  packagesDir: string,
  names: readonly ReusedPackage[] = REUSED_PACKAGES,
): ReusedPackageRequirements[] {
  return names.map((name) => {
    const manifest = readManifest(path.join(packagesDir, name));
    const dependencies = manifest?.dependencies ?? {};
    const externalDependencies: Record<string, string> = {};
    for (const [dependency, range] of Object.entries(dependencies)) {
      if (!isWorkspaceDependency(dependency)) {
        externalDependencies[dependency] = range;
      }
    }
    return { package: name, found: manifest !== undefined, externalDependencies };
  });
}

/**
 * The union of npm dependencies ClawAgent must declare.
 *
 * Starts from what the reused cores ask for, then adds {@link LOAD_PATH_DEPENDENCIES}
 * — which carry a reason, never a version, so the version always comes from the
 * manifest of the package that actually declares it. A load-path name no closure
 * package depends on is reported in `unpinned` rather than being given a made-up
 * range, and `boundary.test.ts` fails on a non-empty list.
 *
 * Where two cores disagree on a version the highest-priority (first-listed)
 * requirement wins, and the disagreement is reported so it can be resolved in
 * the workspace rather than papered over here.
 */
export function collectRequiredExternalDependencies(
  packagesDir: string,
  names: readonly ReusedPackage[] = REUSED_PACKAGES,
): {
  required: Record<string, string>;
  conflicts: Array<{ name: string; ranges: string[] }>;
  unpinned: string[];
} {
  const required: Record<string, string> = {};
  const seen = new Map<string, Set<string>>();
  for (const entry of readReusedPackageRequirements(packagesDir, names)) {
    for (const [name, range] of Object.entries(entry.externalDependencies)) {
      if (required[name] === undefined) {
        required[name] = range;
      }
      const ranges = seen.get(name) ?? new Set<string>();
      ranges.add(range);
      seen.set(name, ranges);
    }
  }

  const unpinned: string[] = [];
  for (const name of Object.keys(LOAD_PATH_DEPENDENCIES)) {
    if (required[name] !== undefined) {
      continue;
    }
    const declaring = SOURCE_LOAD_CLOSURE.map((packageName) => ({
      packageName,
      dependencies: readManifest(path.join(packagesDir, packageName))?.dependencies ?? {},
    })).find((candidate) => typeof candidate.dependencies[name] === "string");
    if (!declaring) {
      unpinned.push(name);
      continue;
    }
    required[name] = declaring.dependencies[name] as string;
  }

  const conflicts: Array<{ name: string; ranges: string[] }> = [];
  for (const [name, ranges] of seen) {
    if (ranges.size > 1) {
      conflicts.push({ name, ranges: [...ranges].sort() });
    }
  }
  return { required, conflicts, unpinned };
}

/**
 * Every npm dependency of every package in the load closure, and what ClawAgent
 * decided about it.
 *
 * This is the audit the two records above exist to make possible: a dependency of
 * loaded code is either declared or refused *on the record*, and adding a core to
 * the closure without looking at its dependencies fails the build instead of
 * failing a phone.
 */
export type LoadClosureDependencyDecision = {
  package: string;
  name: string;
  range: string;
  decision: "declared" | "excluded" | "undecided";
};

export function describeLoadClosureDependencies(
  packagesDir: string,
): LoadClosureDependencyDecision[] {
  const required = collectRequiredExternalDependencies(packagesDir);
  const decisions: LoadClosureDependencyDecision[] = [];
  for (const packageName of SOURCE_LOAD_CLOSURE) {
    const manifest = readManifest(path.join(packagesDir, packageName));
    for (const [name, range] of Object.entries(manifest?.dependencies ?? {})) {
      if (isWorkspaceDependency(name)) {
        continue;
      }
      const decision =
        required.required[name] !== undefined
          ? "declared"
          : UNDECLARED_DEPENDENCIES[name] !== undefined
            ? "excluded"
            : "undecided";
      decisions.push({ package: packageName, name, range, decision });
    }
  }
  return decisions.sort(
    (left, right) =>
      left.package.localeCompare(right.package) || left.name.localeCompare(right.name),
  );
}

/** Load-path names that no longer describe anything real, e.g. after a core refactor. */
export function staleLoadPathRecords(packagesDir: string): { loadPath: string[]; excluded: string[] } {
  const closureDependencies = new Set<string>();
  for (const packageName of SOURCE_LOAD_CLOSURE) {
    const manifest = readManifest(path.join(packagesDir, packageName));
    for (const name of Object.keys(manifest?.dependencies ?? {})) {
      closureDependencies.add(name);
    }
  }
  return {
    loadPath: Object.keys(LOAD_PATH_DEPENDENCIES).filter((name) => !closureDependencies.has(name)),
    excluded: Object.keys(UNDECLARED_DEPENDENCIES).filter((name) => !closureDependencies.has(name)),
  };
}
