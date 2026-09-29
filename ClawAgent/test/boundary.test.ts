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
// Runtime dependencies are zero on purpose: every workspace package resolves its
// imports with `.js` specifiers, which Node's type-stripping loader cannot
// resolve against `.ts` sources. ClawAgent runs from source on the device, so a
// runtime workspace dependency would make it unstartable until a build step
// exists. See `src/config/paths.ts` for the duplication this costs and the
// contract tests that pay it back.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

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
  };

  it("has zero runtime dependencies", () => {
    // A runtime dependency cannot be type-stripped from node_modules, so any
    // entry here breaks the device install, not just the bundle size.
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });

  it("has no optional dependencies", () => {
    // optionalDependencies is where a native addon would hide behind a
    // best-effort install. Probing a builtin (node:sqlite) is the allowed shape.
    expect(Object.keys(manifest.optionalDependencies ?? {})).toEqual([]);
  });

  it("keeps devDependencies inside the pure-TypeScript allowlist", () => {
    const allowed = new Set(["@openclaw/normalization-core", "vitest", "typescript"]);
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
