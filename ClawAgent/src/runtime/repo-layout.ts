// Locating the monorepo checkout that ClawAgent runs inside.
//
// ClawAgent resolves the shared `@openclaw/*` cores from the repository's
// `packages/*/src` trees rather than from installed `dist/` builds, because the
// repo's build chain is native and cannot run on Android. That only works when a
// checkout is present, so finding it — and failing cleanly when it is absent —
// is its own concern.

import { statSync } from "node:fs";
import path from "node:path";

/** How far up to look before concluding this is not a monorepo checkout. */
const MAX_SEARCH_DEPTH = 12;

/**
 * Markers that identify the repository root.
 *
 * `pnpm-workspace.yaml` alone is not enough (a stray parent checkout could have
 * one), and `packages/` alone is far too common. Requiring both, plus the
 * desktop host's own manifest, makes a false positive unlikely.
 */
const ROOT_MARKERS = ["pnpm-workspace.yaml", "packages", "package.json"] as const;

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** True when `directory` looks like the monorepo root. */
export function isMonorepoRoot(directory: string): boolean {
  return (
    isFile(path.join(directory, "pnpm-workspace.yaml")) &&
    isDirectory(path.join(directory, "packages")) &&
    isFile(path.join(directory, "package.json"))
  );
}

/**
 * Walks up from `startDir` to the monorepo root.
 *
 * Returns `undefined` when there is none — for example when ClawAgent has been
 * copied out of the repository onto a device. Callers treat that as "resolve
 * `@openclaw/*` normally", not as an error.
 */
export function findMonorepoRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth += 1) {
    if (isMonorepoRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

/** Absolute path of the `packages/` directory, when the checkout has one. */
export function findPackagesDir(startDir: string): string | undefined {
  const root = findMonorepoRoot(startDir);
  return root ? path.join(root, "packages") : undefined;
}

/**
 * True when a package's source entry point exists in the checkout.
 *
 * Used to decide whether source resolution is even worth attempting, so an
 * installed `dist/` build keeps priority when one is present.
 */
export function hasPackageSource(packagesDir: string, packageName: string): boolean {
  return isFile(path.join(packagesDir, packageName, "src", "index.ts"));
}
