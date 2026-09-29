// Version resolution.
//
// The version lives in `package.json` only. Hardcoding it in source guarantees
// drift the first time the package is bumped, and ClawAgent has no build step to
// inject it. So it is read from disk, by walking up from this module to the
// nearest `package.json` that names this package.
//
// Walking up (rather than assuming `../../package.json`) is what keeps this
// working both when running from source on a phone and when the package is
// installed into a `node_modules` layout with a `dist/` directory between this
// file and the manifest.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The package name this module belongs to. */
export const PACKAGE_NAME = "clawagent";

/** Used when the manifest cannot be read; keeps `--version` from failing. */
export const FALLBACK_VERSION = "0.0.0-unknown";

/** Maximum directories to walk up before giving up. */
const MAX_SEARCH_DEPTH = 8;

type PackageManifest = { name?: unknown; version?: unknown };

/**
 * Finds this package's manifest, starting at `fromUrl` and walking up.
 *
 * Returns `undefined` when no manifest names this package, which callers treat
 * as "use the fallback" rather than an error.
 */
export function findPackageManifest(fromUrl: URL | string = import.meta.url): PackageManifest | undefined {
  let directory: string;
  try {
    const filePath = typeof fromUrl === "string" ? fromUrl : fileURLToPath(fromUrl);
    directory = path.dirname(path.resolve(filePath));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth += 1) {
    const candidate = path.join(directory, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as PackageManifest;
      if (parsed.name === PACKAGE_NAME) {
        return parsed;
      }
    } catch {
      // Not present or not parseable here; keep walking up.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return undefined;
}

/** The version string to report, falling back rather than throwing. */
export function resolvePackageVersion(fromUrl: URL | string = import.meta.url): string {
  const manifest = findPackageManifest(fromUrl);
  return typeof manifest?.version === "string" ? manifest.version : FALLBACK_VERSION;
}
