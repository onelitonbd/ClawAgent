// ClawAgent's import and dependency boundary, enforced as a test.
//
// The mobile host exists because the desktop host cannot run on Android. Every
// rule below is a way that could silently stop being true: a convenient import
// from `src/`, a workspace package that turns out to need a build step, a
// dependency with a native addon, a hardcoded `/usr/bin`. None of those look
// wrong in review, and all of them break on a phone, usually at a moment when
// nobody has one handy.
//
// This file is deliberately self-contained. It walks the directory with
// `node:fs` and parses with `node:path` rather than importing
// `src/test-utils/repo-files.js`, because importing from `src/` is exactly what
// it forbids — a boundary test that violates the boundary proves nothing.
//
// DEPENDENCIES (changed at M1)
//
// M0 had none, because every workspace package resolves its imports with `.js`
// specifiers that Node's type-stripping loader cannot match against `.ts`
// sources. M1 fixes that with a resolve hook (`src/runtime/source-resolution.ts`)
// and then composes the shared cores from source, which is what makes provider
// chat a reuse rather than a reimplementation.
//
// That inversion has a consequence the rules below enforce: because the cores are
// read from the checkout instead of installed, *their* npm dependencies never
// reach an install rooted here. ClawAgent must declare them itself, and the list
// has to match what the cores actually need — recomputed from their manifests on
// every run, never pasted. A missing entry is a confusing ERR_MODULE_NOT_FOUND
// deep inside a provider transport; a stale extra is dead weight on a phone.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// ClawAgent's own modules, not the repository's `src/`: the reuse list and the
// resolver are the things these rules are about, and testing them against a
// second hand-written copy would prove nothing.
import {
  describeLoadClosureDependencies,
  staleLoadPathRecords,
  UNDECLARED_DEPENDENCIES,
  REUSED_PACKAGES,
  SOURCE_LOAD_CLOSURE,
  collectRequiredExternalDependencies,
} from "../src/runtime/reused-packages.ts";
import { resolveOpenClawSource } from "../src/runtime/source-resolution.ts";

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");

/** Source files are the ones whose imports must stay clean. */
const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".mjs", ".js"]);

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

function allFiles(): string[] {
  return walk(PACKAGE_ROOT);
}

function sourceFiles(): string[] {
  return allFiles().filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)));
}

/** Test files may import devDependencies; production files may not. */
function isTestFile(file: string): boolean {
  return /\.test\.m?ts$/u.test(file) || file.includes(`${path.sep}test${path.sep}`);
}

function productionSources(): string[] {
  return sourceFiles().filter((file) => !isTestFile(file));
}

function relative(file: string): string {
  return path.relative(PACKAGE_ROOT, file).split(path.sep).join("/");
}

/**
 * Blanks out comments, preserving length so line numbers stay accurate.
 *
 * Without this the hardcoded-path rule reports a hit on a JSDoc line explaining
 * *why* `/etc/passwd` cannot be used on Termux — prose that is the opposite of a
 * violation. A boundary test that cries wolf on comments gets deleted, so the
 * distinction is worth a small lexer.
 *
 * String, template, and regular-expression literals are tracked so their
 * contents are never mistaken for comment starts. The regex heuristic (a `/`
 * begins a literal when the previous significant token cannot end an
 * expression) is the standard approximation and is sufficient for source that
 * contains no division immediately before a path-looking string.
 */
function blankComments(source: string): string {
  const out = source.split("");
  const blank = (index: number): void => {
    if (out[index] !== "\n") {
      out[index] = " ";
    }
  };
  let state: "code" | "line" | "block" | "single" | "double" | "template" | "regex" = "code";
  let inCharClass = false;
  let previousSignificant = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        blank(index);
        blank(index + 1);
        state = "line";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        blank(index);
        blank(index + 1);
        state = "block";
        index += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        state = char === "'" ? "single" : char === '"' ? "double" : "template";
        previousSignificant = char;
        index += 1;
        continue;
      }
      if (char === "/" && regexCanStartHere(previousSignificant)) {
        state = "regex";
        inCharClass = false;
        previousSignificant = char;
        index += 1;
        continue;
      }
      if (!/\s/u.test(char)) {
        previousSignificant = char;
      }
      index += 1;
      continue;
    }
    if (state === "line") {
      if (char === "\n") {
        state = "code";
      } else {
        blank(index);
      }
      index += 1;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        blank(index);
        blank(index + 1);
        state = "code";
        index += 2;
        continue;
      }
      blank(index);
      index += 1;
      continue;
    }
    if (state === "regex") {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "[") {
        inCharClass = true;
      } else if (char === "]") {
        inCharClass = false;
      } else if (char === "/" && !inCharClass) {
        state = "code";
        previousSignificant = "/";
      }
      index += 1;
      continue;
    }
    // String and template states: only an unescaped matching quote exits.
    if (char === "\\") {
      index += 2;
      continue;
    }
    const terminator = state === "single" ? "'" : state === "double" ? '"' : "`";
    if (char === terminator) {
      state = "code";
      previousSignificant = terminator;
    }
    index += 1;
  }
  return out.join("");
}

/** True when a `/` at this position begins a regex literal rather than division. */
function regexCanStartHere(previousSignificant: string): boolean {
  if (previousSignificant === "") {
    return true;
  }
  return "(,=:[!&|?{};+-*%~^<>".includes(previousSignificant);
}

/** Reads a file with comments blanked, for rules that must only see code. */
function codeOf(file: string): string {
  return blankComments(readFileSync(file, "utf8"));
}

/** Every import/require/re-export specifier in a file. */
function importSpecifiers(file: string): string[] {
  const source = codeOf(file);
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/gu,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

/**
 * The one file above the package root that ClawAgent may import.
 *
 * `node-version.mjs` is explicitly a shared, zero-dependency contract owned by
 * the repository: it ships in the published package's `files`, both the source
 * and packaged entry points read it, and the Node floor it declares protects
 * `node:sqlite` TEXT correctness. Re-declaring that floor locally would be the
 * actual drift risk.
 */
const ALLOWED_EXTERNAL_FILES = new Set(["../../../node-version.mjs"]);

/** Node builtins are always allowed. */
function isBuiltinSpecifier(specifier: string): boolean {
  return specifier.startsWith("node:");
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

describe("ClawAgent import boundary", () => {
  it("has production source files to check", () => {
    // Guards against a refactor silently emptying the set and passing vacuously.
    expect(productionSources().length).toBeGreaterThan(0);
  });

  it("never imports the openclaw root package", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const specifier of importSpecifiers(file)) {
        if (specifier === "openclaw" || specifier.startsWith("openclaw/")) {
          offenders.push(`${relative(file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never imports extensions, plugin-sdk, or memory-host-sdk", () => {
    // These escape into `src/` and carry ~10k internal imports; they are the
    // contamination the rebuild exists to avoid.
    const forbidden = [/^extensions\//u, /plugin-sdk/u, /memory-host-sdk/u];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const specifier of importSpecifiers(file)) {
        if (forbidden.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${relative(file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never reaches into the desktop host's src/ or other workspace packages", () => {
    const offenders: string[] = [];
    for (const file of productionSources()) {
      for (const specifier of importSpecifiers(file)) {
        if (!isRelativeSpecifier(specifier)) {
          continue;
        }
        const resolved = path.resolve(path.dirname(file), specifier);
        const insidePackage =
          resolved === PACKAGE_ROOT || resolved.startsWith(`${PACKAGE_ROOT}${path.sep}`);
        if (insidePackage || ALLOWED_EXTERNAL_FILES.has(specifier)) {
          continue;
        }
        offenders.push(`${relative(file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses real file extensions in every relative specifier", () => {
    // Node's type-stripping loader resolves only real files. A `.js` specifier
    // pointing at a `.ts` source is ERR_MODULE_NOT_FOUND on the device, which is
    // why this package diverges from the repository's `.js` convention.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const specifier of importSpecifiers(file)) {
        if (!isRelativeSpecifier(specifier)) {
          continue;
        }
        const extension = path.extname(specifier);
        if (!SOURCE_EXTENSIONS.has(extension)) {
          offenders.push(`${relative(file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never imports a native addon or node-pty", () => {
    // Termux cannot load glibc-linked prebuilds, and node-pty is a native
    // module. Terminal tools go through child_process instead.
    const forbidden = [/^node-pty$/u, /\.node$/u, /^@lydell\//u];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const specifier of importSpecifiers(file)) {
        if (forbidden.some((pattern) => pattern.test(specifier))) {
          offenders.push(`${relative(file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never hardcodes a host system path", () => {
    // Termux has no /bin, no /usr/bin, no /etc and no writable /var. Anything
    // absolute must come from $PREFIX or $PATH at runtime.
    const pattern = /["'`](?:\/bin\/|\/usr\/bin\/|\/usr\/local\/|\/etc\/|\/var\/)/u;
    const offenders: string[] = [];
    for (const file of productionSources()) {
      const source = codeOf(file);
      const lineNumber = source.split("\n").findIndex((line) => pattern.test(line));
      if (lineNumber >= 0) {
        offenders.push(`${relative(file)}:${lineNumber + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("ClawAgent dependency boundary", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    clawagent?: {
      reusedPackages?: string[];
      externalDependenciesOfReusedCores?: string[];
    };
  };
  const dependencies = manifest.dependencies ?? {};
  const workspaceDeps = Object.keys(dependencies).filter((name) =>
    name.startsWith("@openclaw/"),
  );
  const externalDeps = Object.keys(dependencies).filter(
    (name) => !name.startsWith("@openclaw/"),
  );

  it("declares every reused core outside the npm dependency graph", () => {
    // The relationship has to be written down somewhere, or a standalone install
    // of this package silently loses it — but `dependencies` is the wrong place.
    // The only range that could express "use this checkout" is `workspace:*`,
    // which is a pnpm protocol: naming it in `dependencies` makes the plain
    // `npm install --omit=dev` the README gives a phone user fail before it
    // installs anything.
    const declared = [...(manifest.clawagent?.reusedPackages ?? [])].sort();
    expect(declared).toEqual([...REUSED_PACKAGES].sort());
    expect(workspaceDeps).toEqual([]);
  });

  it("installs with a plain npm install on a device", () => {
    // Every range must be something npm can fetch from the registry. This is the
    // guard for the class of bug above: any package-manager-specific protocol,
    // a git or file reference, or an alias makes the install line in the README
    // unusable, and on a phone that is the whole product.
    const registryRange = /^(?:\d+\.\d+\.\d+(?:[-+][\w.-]+)?|[\x7f<>=[\]().,*| 0-9ux^~.-]+)$/u;
    const offenders: string[] = [];
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (range.includes(":") || !registryRange.test(range)) {
          offenders.push(`${field}.${name}: "${range}" is not a registry range`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares exactly the external packages the reused cores need", () => {
    // Recomputed from the cores' own manifests on every run. This is the drift
    // guard: adding a core, or a core gaining a dependency, fails here until the
    // install list is updated deliberately rather than by accident.
    const { required, conflicts, unpinned } = collectRequiredExternalDependencies(PACKAGES_DIR);
    expect(conflicts).toEqual([]);
    // A load-path entry with no package to take a version from would otherwise
    // land in package.json as a bare name with whatever npm feels like serving.
    expect(unpinned).toEqual([]);
    expect(externalDeps.sort()).toEqual(Object.keys(required).sort());
  });

  it("records a decision for every dependency of loaded code", () => {
    // The failure this prevents is the interesting one: a reused core gains a
    // transitive package, that package's npm dependencies are absent on a phone,
    // and nothing in this repository says so. `@openclaw/ai` reaching
    // markdown-core for a reasoning-tag parser is exactly that case, discovered
    // by loading the graph rather than reading a manifest.
    const undecided = describeLoadClosureDependencies(PACKAGES_DIR).filter(
      (entry) => entry.decision === "undecided",
    );
    expect(
      undecided.map((entry) => `${entry.package} -> ${entry.name} (${entry.range})`),
    ).toEqual([]);
  });

  it("justifies every excluded dependency", () => {
    // An exclusion without a reason is indistinguishable from an oversight, and
    // the next person re-adds the package.
    const unexplained = Object.entries(UNDECLARED_DEPENDENCIES)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([name]) => name);
    expect(unexplained).toEqual([]);
  });

  it("keeps the dependency records about things that still exist", () => {
    // Both maps name files in packages/*. When a core refactors, the entry has
    // to go rather than quietly describe nothing.
    const stale = staleLoadPathRecords(PACKAGES_DIR);
    expect(stale.loadPath).toEqual([]);
    expect(stale.excluded).toEqual([]);
  });

  it("keeps the manifest's own dependency record true", () => {
    // `clawagent.externalDependenciesOfReusedCores` is the human-facing
    // explanation of why those packages are in `dependencies` at all — a reader
    // cannot recompute it, so the claim is either checked or it lies.
    const recorded = [...(manifest.clawagent?.externalDependenciesOfReusedCores ?? [])].sort();
    const { required } = collectRequiredExternalDependencies(PACKAGES_DIR);
    expect(recorded).toEqual(Object.keys(required).sort());
  });

  it("pins external dependencies to the versions the cores declare", () => {
    // Two versions of one SDK in a single process is how a provider starts
    // failing in ways that look like a network problem.
    const { required } = collectRequiredExternalDependencies(PACKAGES_DIR);
    const mismatched = externalDeps
      .filter((name) => dependencies[name] !== required[name])
      .map((name) => `${name}: declared ${dependencies[name]}, cores want ${required[name]}`);
    expect(mismatched).toEqual([]);
  });

  it("has no optional dependencies", () => {
    // optionalDependencies is where a native addon would hide behind a
    // best-effort install. Probing a builtin (node:sqlite) is the allowed shape.
    expect(Object.keys(manifest.optionalDependencies ?? {})).toEqual([]);
  });

  it("keeps no native addon anywhere in the dependency set", () => {
    // Termux cannot load glibc-linked prebuilds. The deny list names the packages
    // that would be tempting to reach for and cannot be used here.
    const native = [
      /^node-pty$/u,
      /^sharp$/u,
      /^canvas$/u,
      /^better-sqlite3$/u,
      /^sqlite3$/u,
      /^@lydell\//u,
      /^@rolldown\//u,
      /^esbuild$/u,
      /^lightningcss$/u,
    ];
    const offenders = [...workspaceDeps, ...externalDeps].filter((name) =>
      native.some((pattern) => pattern.test(name)),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps devDependencies inside the pure-TypeScript allowlist", () => {
    const allowed = new Set(["vitest", "typescript", "@types/node"]);
    const unexpected = Object.keys(manifest.devDependencies ?? {}).filter(
      (name) => !allowed.has(name),
    );
    expect(unexpected).toEqual([]);
  });

  it("ships no compiled artifacts in the tree", () => {
    const binaries = allFiles().filter((file) => /\.(?:node|o|a|so|dylib|dll)$/u.test(file));
    expect(binaries.map(relative)).toEqual([]);
  });
});

describe("ClawAgent reuse boundary", () => {
  /** Every `@openclaw/*` specifier ClawAgent source actually imports. */
  function openclawSpecifiers(): Array<{ file: string; specifier: string }> {
    const found: Array<{ file: string; specifier: string }> = [];
    for (const file of sourceFiles()) {
      for (const specifier of importSpecifiers(file)) {
        if (specifier.startsWith("@openclaw/")) {
          found.push({ file, specifier });
        }
      }
    }
    return found;
  }

  /** Reads the public entry points a package declares. */
  function declaredExports(packageName: string): Set<string> {
    const manifestPath = path.join(PACKAGES_DIR, packageName, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      exports?: Record<string, unknown>;
    };
    return new Set(Object.keys(manifest.exports ?? {}));
  }

  it("imports shared cores, proving the rule below is not vacuous", () => {
    expect(openclawSpecifiers().length).toBeGreaterThan(0);
  });

  it("only imports cores on the declared reuse list", () => {
    // The reuse list is a decision, not an accident of what happened to resolve.
    const offenders = openclawSpecifiers()
      .map(({ specifier }) => specifier.slice("@openclaw/".length).split("/")[0] ?? "")
      .filter((packageName) => !SOURCE_LOAD_CLOSURE.includes(packageName));
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it("only imports declared public entry points", () => {
    // Deep imports into another package's internals (`@openclaw/ai/src/...`)
    // would resolve through the fallback rule and then break the moment that
    // package moves a file. Only what `exports` declares is a contract.
    const offenders: string[] = [];
    for (const { file, specifier } of openclawSpecifiers()) {
      const [packageName, ...subpath] = specifier.slice("@openclaw/".length).split("/");
      if (!packageName) {
        continue;
      }
      const key = subpath.length === 0 ? "." : `./${subpath.join("/")}`;
      if (!declaredExports(packageName).has(key)) {
        offenders.push(`${relative(file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("resolves every imported specifier to real TypeScript source", () => {
    // Regression guard for a bug that made `@openclaw/ai/providers` unloadable:
    // `@openclaw/llm-core/event-stream` declares `./dist/utils/event-stream.mjs`,
    // so its source is nested at `src/utils/event-stream.ts`. A resolver that
    // assumed `src/<subpath>.ts` mapped it to nothing. Any subpath that stops
    // resolving fails here rather than on a device.
    const offenders: string[] = [];
    for (const { file, specifier } of openclawSpecifiers()) {
      const resolved = resolveOpenClawSource(specifier, PACKAGES_DIR);
      if (!resolved || !statSync(resolved.file).isFile()) {
        offenders.push(`${relative(file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("resolves the subpaths that once broke, by name", () => {
    // Named separately so a failure points at the exact contract that regressed
    // instead of at whichever file happened to import it first.
    for (const specifier of [
      "@openclaw/ai",
      "@openclaw/ai/providers",
      "@openclaw/llm-core",
      "@openclaw/llm-core/event-stream",
      "@openclaw/llm-core/diagnostics",
      "@openclaw/media-core/base64",
      "@openclaw/normalization-core/agent-id",
      "@openclaw/normalization-core/home-dir",
    ]) {
      const resolved = resolveOpenClawSource(specifier, PACKAGES_DIR);
      expect(resolved, `${specifier} did not resolve`).toBeTruthy();
      expect(resolved?.via, `${specifier} fell back to the layout heuristic`).toBe("exports");
    }
  });
});

describe("ClawAgent package shape", () => {
  it("declares a Termux-compatible engines range", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { engines?: { node?: string }; bin?: Record<string, string> };
    expect(manifest.engines?.node).toBeTruthy();
    // The bin must exist and be plain JS: it is the one module that has to load
    // before type stripping is known to work.
    const bin = manifest.bin?.clawagent;
    expect(bin).toBeTruthy();
    expect(path.extname(bin ?? "")).toBe(".mjs");
    expect(statSync(path.join(PACKAGE_ROOT, bin ?? "")).isFile()).toBe(true);
  });
});

describe("ClawAgent CLI startup closure", () => {
  /**
   * The modules `node bin/clawagent.mjs --help` loads before it prints anything.
   *
   * Kept as an explicit list of entries plus a walk, rather than as a list of
   * files, so that adding an import to a CLI module puts that module under the
   * rule automatically. Following only *relative* specifiers is what stops the
   * walk at the shared cores: they are allowed to import npm packages, and the
   * entry point loads them lazily, so they are not part of the startup cost.
   */
  const STARTUP_ENTRIES = ["src/cli/main.ts", "bin/clawagent.mjs"];

  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
  }

  /** Specifiers a file loads *statically*, i.e. before any of its code runs. */
  function staticSpecifiers(file: string): string[] {
    const source = stripComments(readFileSync(file, "utf8"));
    const found: string[] = [];
    for (const match of source.matchAll(/(?:^|\n)[ \t]*(import|export)([^;]*?)from[ \t]*["']([^"']+)["']/g)) {
      const clause = (match[2] ?? "").trim();
      // `import type` and `export type` vanish under Node's type stripping, so
      // they cost nothing at startup. `import { type A, B }` does not: B is real.
      if (/^type(\s|$)/u.test(clause)) {
        continue;
      }
      found.push(match[3] as string);
    }
    return found;
  }

  function isBare(specifier: string): boolean {
    return (
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("#") &&
      !/^[a-z+.-]+:/iu.test(specifier)
    );
  }

  function startupClosure(): string[] {
    const seen = new Set<string>();
    const queue = STARTUP_ENTRIES.map((entry) => path.join(PACKAGE_ROOT, entry));
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
        continue;
      }
      seen.add(file);
      for (const specifier of staticSpecifiers(file)) {
        if (specifier.startsWith(".")) {
          queue.push(path.resolve(path.dirname(file), specifier));
        }
      }
    }
    return [...seen].sort();
  }

  it("reaches every module in the package's own CLI tree", () => {
    // A guard that quietly walks nothing is worse than no guard: it reads as
    // coverage. `chat` and `agent` are both reachable from `main.ts`, so if the
    // walk ever stops at a barrel file or a changed path, this fails first.
    const closure = startupClosure();
    expect(closure).toContain(path.join(PACKAGE_ROOT, "src/cli/chat.ts"));
    expect(closure).toContain(path.join(PACKAGE_ROOT, "src/cli/agent.ts"));
    expect(closure.length).toBeGreaterThan(10);
  });

  it("statically imports nothing that only an npm install can provide", () => {
    // The failure this prevents is total: one static `import { Type } from
    // "typebox"` anywhere in this closure means `clawagent doctor`, `version`, and
    // `help` all die with ERR_MODULE_NOT_FOUND on a checkout that has not run
    // `npm install` yet. That is the opposite of what doctor is for - it is the
    // command the README tells you to run to find out whether the install worked -
    // and on a phone it is also the only command that can explain the failure.
    // The fix is to import the heavy thing where it is used, inside the async
    // function that needs it, which is what `runAgent` and `createAgentSession`
    // do for the tool layer.
    // `@openclaw/*` is excluded because it is not an install requirement: the
    // entry point maps those specifiers onto `packages/*/src` in this very
    // checkout, and `src/config/paths.ts` relies on that for the home-directory
    // rules it refuses to reimplement. Everything else bare can only come from
    // `node_modules`.
    const offenders: string[] = [];
    for (const file of startupClosure()) {
      for (const specifier of staticSpecifiers(file)) {
        if (isBare(specifier) && !specifier.startsWith("@openclaw/")) {
          offenders.push(`${path.relative(PACKAGE_ROOT, file)} -> "${specifier}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
