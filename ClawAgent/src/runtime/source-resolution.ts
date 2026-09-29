// Source resolution for the shared `@openclaw/*` cores.
//
// WHY THIS EXISTS
//
// ClawAgent reuses the repository's shared cores (`ai`, `agent-core`,
// `llm-core`, ...) instead of reimplementing them. Two facts make that
// non-trivial on a phone:
//
//   1. Those packages import each other with `.js` specifiers (`./helper.js`
//      resolving to `helper.ts`), which works because a build step emits the
//      `.js`. The repo's build chain is native (rolldown/tsdown) and cannot run
//      on Android, so there is no `dist/` on the device.
//   2. Node's type-stripping loader resolves only files that actually exist, so
//      a `.js` specifier pointing at a `.ts` source is ERR_MODULE_NOT_FOUND.
//
// The alternative approaches are all worse: bundling on the device needs native
// tooling; committing a bundle violates the repo's never-commit-dist convention
// and cannot be reviewed; vendoring a rewritten copy duplicates thousands of
// files and guarantees behavioural drift from OpenClaw, which is the one thing
// this rebuild must not do.
//
// So resolution is fixed at load time instead. `module.registerHooks` installs a
// synchronous, in-thread resolve hook (no worker, unlike `module.register`) that:
//
//   - maps `@openclaw/<pkg>[/<sub>]` to a TypeScript file under
//     `<repo>/packages/<pkg>/src/`, using the package's own `exports` map
//   - rewrites a relative `.js`/`.mjs` specifier to `.ts`/`.mts` when only the
//     TypeScript file exists
//
// The `exports` map is authoritative and must be read, not guessed. An earlier
// version of this resolver assumed every subpath mapped to `src/<subpath>.ts`,
// which is false: `@openclaw/llm-core/event-stream` declares
// `./dist/utils/event-stream.mjs`, so its source is `src/utils/event-stream.ts`.
// Guessing there made `@openclaw/ai/providers` unloadable, because its adapters
// import that exact subpath. The dist-to-src substitution below is derived from
// the declared target instead, with the flat layout kept only as a fallback.
//
// An installed build always wins: the bare-specifier mapping is only attempted
// after normal resolution fails, and the extension rewrite only fires when the
// `.js` file is genuinely absent. So this hook is inert in a built checkout.
//
// NON-ERASABLE SYNTAX
//
// A handful of reused files use TypeScript parameter properties
// (`constructor(private readonly x: T)`), which strip-only mode rejects with
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX — measured across the reuse list: `retry`
// (its only file), `ai` (1 file), `terminal-core` (3), `gateway-client` (8).
// Node's `--experimental-transform-types` handles them, which is why the entry
// point respawns itself with that flag. See `./node-flags.ts`.
//
// The pure resolvers below are exported separately from the hook installation so
// they can be unit-tested without touching the module loader.

import { readFileSync, statSync } from "node:fs";
import { readdirSync, type Dirent } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Specifier prefix that identifies the shared cores. */
export const OPENCLAW_SCOPE = "@openclaw/";

/** Extension pairs rewritten when only the TypeScript file exists. */
const JS_TO_TS_EXTENSIONS: ReadonlyArray<readonly [string, string]> = [
  [".js", ".ts"],
  [".mjs", ".mts"],
  [".jsx", ".tsx"],
];

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Result of mapping an `@openclaw/*` specifier into the checkout. */
export type OpenClawSourceResolution = {
  /** Absolute path to the TypeScript source file. */
  file: string;
  /** Which rule produced it, for diagnostics. */
  via: OpenClawResolutionRule;
};

/** Rules the resolver tries, in order of specificity. */
export type OpenClawResolutionRule =
  | "exports"
  | "entry"
  | "subpath"
  | "subpath-extension"
  | "directory-index";

/** Build extensions stripped when turning a declared target into a source stem. */
const TARGET_EXTENSIONS: readonly string[] = [".d.mts", ".d.ts", ".d.cts", ".mts", ".cts", ".mjs", ".cjs", ".js", ".ts"];

function stripTargetExtension(relativePath: string): string {
  for (const extension of TARGET_EXTENSIONS) {
    if (relativePath.endsWith(extension)) {
      return relativePath.slice(0, -extension.length);
    }
  }
  return relativePath;
}

type ManifestCacheEntry = { exports: Record<string, unknown> } | undefined;

/**
 * Per-directory manifest cache.
 *
 * The resolve hook runs synchronously for every specifier in the graph, and a
 * provider load touches hundreds. Reading and parsing one small JSON file per
 * package, once, keeps that off the hot path.
 */
const manifestCache = new Map<string, ManifestCacheEntry>();

function readPackageExports(packageDir: string): Record<string, unknown> | undefined {
  const cached = manifestCache.get(packageDir);
  if (cached !== undefined) {
    return cached?.exports;
  }
  let parsed: ManifestCacheEntry;
  try {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      exports?: unknown;
    };
    parsed =
      manifest.exports && typeof manifest.exports === "object" && !Array.isArray(manifest.exports)
        ? { exports: manifest.exports as Record<string, unknown> }
        : undefined;
  } catch {
    parsed = undefined;
  }
  manifestCache.set(packageDir, parsed);
  return parsed?.exports;
}

/** Drops the resolution caches. Used by tests that build fake checkouts. */
export function resetSourceResolutionCache(): void {
  manifestCache.clear();
  // The listing cache is keyed by directory, so a rebuilt fake checkout would
  // otherwise be scanned once and then read from a stale entry forever.
  sourceFileListings.clear();
}

/**
 * Picks the concrete file a conditional export entry points at.
 *
 * Prefers runtime conditions over `types`, because a `.d.ts` target has no
 * source counterpart to load.
 */
function exportTargetPath(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const record = entry as Record<string, unknown>;
    for (const condition of ["import", "node", "default", "require", "types"]) {
      const target = exportTargetPath(record[condition]);
      if (target) {
        return target;
      }
    }
  }
  return undefined;
}

/** Extensions a source file can carry, in the order the resolver tries them. */
const SOURCE_EXTENSIONS: readonly string[] = [".ts", ".mts", ".tsx", ".js"];

/**
 * Source files under `src`, relative to `src`, excluding test scaffolding.
 *
 * Cached per package because the last-resort rule below runs a directory walk,
 * and a walk per specifier on a phone is exactly the kind of startup cost this
 * host cannot afford. `resetSourceResolutionCache` clears it.
 */
const sourceFileListings = new Map<string, string[]>();

function listSourceFiles(srcDir: string): string[] {
  const cached = sourceFileListings.get(srcDir);
  if (cached) {
    return cached;
  }
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > 6) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = directory === srcDir ? entry.name : `${directory.slice(srcDir.length + 1)}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(srcDir, entry.name), depth + 1);
      } else if (
        /\.[cm]?ts$/u.test(entry.name) &&
        !/\.(test|spec)\.[cm]?ts$/u.test(entry.name) &&
        !/\.test-support\.[cm]?ts$/u.test(entry.name)
      ) {
        found.push(relative);
      }
    }
  };
  walk(srcDir, 0);
  // Cap the listing so an unexpected tree cannot pin a large array per package.
  const listing = found.length > 4000 ? found.slice(0, 4000) : found;
  sourceFileListings.set(srcDir, listing);
  return listing;
}

/**
 * Last-resort rule for a package whose build flattens `src/**` to `dist/*`.
 *
 * `@openclaw/ai` is such a package: `./diagnostics` declares
 * `./dist/diagnostics.mjs`, and the module is `src/utils/diagnostics.ts`. Those
 * modules also moved out of the package root, so no path rule can derive the
 * location — but the basename is unique inside `src`, which is enough to find it
 * without guessing. Applied only when every other rule failed, and only when
 * exactly one non-test file carries that basename, so an ambiguous name is left
 * unresolved rather than coin-flipped.
 *
 * This matters: `agent-core`'s `agent-stream-response.ts` imports
 * `@openclaw/ai/diagnostics` at module scope, and that file is reached through
 * `agent-loop.ts`, so without this rule the whole agent loop is unloadable from
 * source. Redirecting to `@openclaw/llm-core/diagnostics` instead is *wrong* —
 * the `ai` shim re-exports llm-core's diagnostics plus its own symbols, and the
 * export agent-core needs (`isResponsesOutputLimitToolCallError`) is one of them.
 */
function uniqueNestedSourceCandidate(packageDir: string, stem: string): string[] {
  const name = path.basename(stem);
  const srcDir = path.join(packageDir, "src");
  const matches = listSourceFiles(srcDir).filter(
    (relative) => path.basename(relative, path.extname(relative)) === name,
  );
  return matches.length === 1 ? [`src/${matches[0]}`] : [];
}

/**
 * Candidates for a dist path that is the flattened output of a source directory.
 *
 * `harness/compaction` -> `src/harness/compaction/{index,compaction}.ts`. Only
 * consulted when no source file matches the stem directly, so a genuine
 * `<stem>.ts` still wins and nothing that already resolves can change.
 */
function flattenedDirectoryCandidates(stem: string): string[] {
  const name = path.basename(stem);
  const parent = path.dirname(stem);
  const directory = parent === "." ? `src/${name}` : `src/${parent}/${name}`;
  const candidates: string[] = [];
  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(`${directory}/index${extension}`);
    candidates.push(`${directory}/${name}${extension}`);
  }
  return candidates;
}

/**
 * Source-file candidates for a declared export target.
 *
 * Three shapes occur in this workspace, and all three have to work:
 *   `./dist/utils/event-stream.mjs` -> `src/utils/event-stream.ts`
 *   `./dist/index.js`               -> `src/index.ts`
 *   `./dist/harness/compaction.js`  -> `src/harness/compaction/compaction.ts`
 *
 * The third is why guessing `<stem>.ts` alone is not enough: a build step can
 * collapse a source *directory* into one dist file, which `@openclaw/agent-core`
 * does. Its sibling entry `./harness/branch-summarization` cannot be recovered by
 * any path rule — the file is `harness/compaction/branch-summarization.ts`, and
 * no `harness/branch-summarization.ts` exists at all — so that one subpath stays
 * unresolved and is recorded in AGENTS.md rather than guessed at.
 */
function sourceCandidatesForTarget(packageDir: string, target: string): string[] {
  const relative = target.replace(/^\.\//u, "");
  if (relative.startsWith("dist/")) {
    const stem = stripTargetExtension(relative.slice("dist/".length));
    const candidates = SOURCE_EXTENSIONS.map((extension) => `src/${stem}${extension}`);
    candidates.push(`src/${stem}/index.ts`);
    candidates.push(...flattenedDirectoryCandidates(stem));
    candidates.push(...uniqueNestedSourceCandidate(packageDir, stem));
    return candidates;
  }
  if (relative.startsWith("src/")) {
    const stem = stripTargetExtension(relative.slice("src/".length));
    const candidates = [relative];
    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = `src/${stem}${extension}`;
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
    const index = `src/${stem}/index.ts`;
    if (!candidates.includes(index)) {
      candidates.push(index);
    }
    return candidates;
  }
  return [];
}

/** Resolves a subpath through the package's `exports` map. */
function resolveViaExports(
  packageDir: string,
  subpath: readonly string[],
): string | undefined {
  const exports = readPackageExports(packageDir);
  if (!exports) {
    return undefined;
  }
  const key = subpath.length === 0 ? "." : `./${subpath.join("/")}`;
  const entry = exports[key];
  if (entry === undefined) {
    return undefined;
  }
  const target = exportTargetPath(entry);
  if (!target) {
    return undefined;
  }
  for (const candidate of sourceCandidatesForTarget(packageDir, target)) {
    const absolute = path.join(packageDir, candidate);
    if (isFile(absolute)) {
      return absolute;
    }
  }
  return undefined;
}

/**
 * Resolves a bare npm specifier against `ClawAgent/node_modules`.
 *
 * WHY THIS IS NEEDED, and why it is not laziness about `NODE_PATH`
 *
 * The reused cores live in `packages/<name>/src` and import their own npm
 * dependencies by bare name (`openai`, `mdast-util-from-markdown`). Node looks
 * for `node_modules` by walking *upward from the importing file*, so those
 * imports resolve against the repository root — which works on a development
 * machine that has installed the monorepo, and fails on a phone that followed
 * this README and installed inside `ClawAgent/`. The failure is deep inside a
 * provider transport, several hops from anything the user typed.
 *
 * `NODE_PATH` is not the fix: it is honoured by CommonJS `require` and ignored
 * for ES module resolution, and the vendor SDKs are imported as ES modules.
 *
 * So the fallback re-uses Node's own resolver with a synthetic parent inside the
 * ClawAgent package, which is exactly where its `node_modules` lives. Normal
 * resolution always gets the first attempt, so a proper install (or a built
 * checkout) wins and this never shadows it.
 */
export function resolveRuntimeDependency(
  specifier: string,
  runtimeDependenciesDir: string,
): string | undefined {
  if (!isBareSpecifier(specifier)) {
    return undefined;
  }
  const probe = path.join(runtimeDependenciesDir, "__clawagent_resolution_probe__.mjs");
  try {
    const url = import.meta.resolve(specifier, pathToFileURL(probe).href);
    if (!url.startsWith("file:")) {
      return undefined;
    }
    const file = fileURLToPath(url);
    return isFile(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

/** True for `pkg`, `@scope/pkg/sub`; false for relative, absolute, and URL specifiers. */
export function isBareSpecifier(specifier: string): boolean {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return false;
  }
  return !/^[a-z+.-]+:/iu.test(specifier);
}

/**
 * Maps `@openclaw/<pkg>[/<sub>]` to a TypeScript source file in `packagesDir`.
 *
 * The package's `exports` map decides the source path; the flat
 * `src/<subpath>.ts` layout is only a fallback for a package with no map or a
 * specifier the map does not declare. Resolution that cannot be satisfied
 * returns `undefined` so the caller can surface the original module error,
 * which names the specifier the way the user wrote it.
 */
export function resolveOpenClawSource(
  specifier: string,
  packagesDir: string,
): OpenClawSourceResolution | undefined {
  if (!specifier.startsWith(OPENCLAW_SCOPE)) {
    return undefined;
  }
  const remainder = specifier.slice(OPENCLAW_SCOPE.length);
  if (!remainder) {
    return undefined;
  }
  const [packageName, ...subpath] = remainder.split("/");
  if (!packageName) {
    return undefined;
  }
  const packageDir = path.join(packagesDir, packageName);
  const srcDir = path.join(packageDir, "src");

  const fromExports = resolveViaExports(packageDir, subpath);
  if (fromExports) {
    return { file: fromExports, via: "exports" };
  }

  if (!subpath.length) {
    const entry = path.join(srcDir, "index.ts");
    return isFile(entry) ? { file: entry, via: "entry" } : undefined;
  }
  const target = path.join(srcDir, ...subpath);
  if (isFile(target)) {
    return { file: target, via: "subpath" };
  }
  const withExtension = `${target}.ts`;
  if (isFile(withExtension)) {
    return { file: withExtension, via: "subpath-extension" };
  }
  const directoryIndex = path.join(target, "index.ts");
  if (isFile(directoryIndex)) {
    return { file: directoryIndex, via: "directory-index" };
  }
  return undefined;
}

/**
 * Rewrites a relative `.js`-style specifier to its TypeScript source.
 *
 * Returns `undefined` when the JavaScript file exists (a real build wins) or
 * when no TypeScript counterpart does.
 */
export function resolveTypeScriptSibling(
  specifier: string,
  parentFileUrl: string,
): string | undefined {
  if (!parentFileUrl.startsWith("file:")) {
    return undefined;
  }
  const extension = JS_TO_TS_EXTENSIONS.find(([js]) => specifier.endsWith(js));
  if (!extension) {
    return undefined;
  }
  const [jsExtension, tsExtension] = extension;
  let parentDirectory: string;
  try {
    parentDirectory = path.dirname(fileURLToPath(parentFileUrl));
  } catch {
    return undefined;
  }
  const jsPath = path.resolve(parentDirectory, specifier);
  if (isFile(jsPath)) {
    return undefined;
  }
  const tsPath = `${jsPath.slice(0, -jsExtension.length)}${tsExtension}`;
  return isFile(tsPath) ? tsPath : undefined;
}

export type SourceResolutionHooks = {
  /** True when hooks were installed. */
  installed: boolean;
  /** Why not, when `installed` is false. */
  reason?: "no-packages-dir" | "register-hooks-unavailable";
  /** Where `@openclaw/*` resolves from, when known. */
  packagesDir?: string;
};

/**
 * Installs the resolve hook.
 *
 * Safe to call when `packagesDir` is unknown: it reports that and changes
 * nothing, so an installed ClawAgent without a checkout behaves normally.
 */
export function installSourceResolutionHooks(
  options: {
    packagesDir?: string | undefined;
    /**
     * Directory whose `node_modules` holds the npm packages the reused cores
     * import — normally the ClawAgent package itself. See
     * {@link resolveRuntimeDependency}; omitted means no npm fallback.
     */
    runtimeDependenciesDir?: string | undefined;
    /** Called for every specifier mapped to source; useful for `doctor --json`. */
    onResolved?: (specifier: string, file: string) => void;
  } = {},
): SourceResolutionHooks {
  const packagesDir = options.packagesDir;
  const runtimeDependenciesDir = options.runtimeDependenciesDir;
  if (!packagesDir) {
    return { installed: false, reason: "no-packages-dir" };
  }
  if (typeof registerHooks !== "function") {
    return { installed: false, reason: "register-hooks-unavailable", packagesDir };
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      // An installed build always wins: only fall back to source when normal
      // resolution cannot satisfy the specifier.
      if (specifier.startsWith(OPENCLAW_SCOPE)) {
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          const mapped = resolveOpenClawSource(specifier, packagesDir);
          if (!mapped) {
            throw error;
          }
          options.onResolved?.(specifier, mapped.file);
          return {
            url: pathToFileURL(mapped.file).href,
            shortCircuit: true,
          };
        }
      }

      if (context.parentURL) {
        const rewritten = resolveTypeScriptSibling(specifier, context.parentURL);
        if (rewritten) {
          options.onResolved?.(specifier, rewritten);
          return { url: pathToFileURL(rewritten).href, shortCircuit: true };
        }
      }

      if (!runtimeDependenciesDir) {
        return nextResolve(specifier, context);
      }
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const dependency = resolveRuntimeDependency(specifier, runtimeDependenciesDir);
        if (!dependency) {
          throw error;
        }
        options.onResolved?.(specifier, dependency);
        return { url: pathToFileURL(dependency).href, shortCircuit: true };
      }
    },
  });

  return { installed: true, packagesDir };
}
