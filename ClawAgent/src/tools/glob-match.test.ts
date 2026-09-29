// The glob dialect the search tools speak.
//
// Pinned case by case because a glob that silently matches *more* than asked is
// how `grep --glob "*.ts"` ends up scanning a build directory on a device that
// cannot afford it, and one that matches less looks like a broken tool.

import { describe, expect, it } from "vitest";
import { globToRegExp, matchesGlob } from "./glob-match.ts";

describe("matchesGlob", () => {
  it.each([
    // A slash-free pattern matches at any depth, which is what everyone means by it.
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", true],
    ["*.ts", "src/deep/a.ts", true],
    ["*.ts", "src/a.js", false],
    // Dotfiles are never reached by a leading wildcard.
    ["*.ts", ".hidden.ts", false],
    ["*.ts", "src/.hidden.ts", false],
    [".*", ".env", true],
    [".env", ".env", true],
    [".env", ".env.example", false],
    // `**/` may also match nothing, so `**/*.ts` finds a root file.
    ["**/*.ts", "a.ts", true],
    ["**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/x/y/a.ts", true],
    ["src/**/x", "src/x", true],
    // One `*` stays inside a segment.
    ["src/*/a.ts", "src/x/a.ts", true],
    ["src/*/a.ts", "src/x/y/a.ts", false],
    ["a?c", "abc", true],
    ["a?c", "ac", false],
    ["a?c", "a/c", false],
    // Classes, with both negation spellings.
    ["[ab].ts", "a.ts", true],
    ["[ab].ts", "c.ts", false],
    ["[!ab].ts", "c.ts", true],
    ["[!ab].ts", "a.ts", false],
    ["[^ab].ts", "c.ts", true],
    // Alternation, compiled per branch.
    ["{*.ts,*.js}", "a.ts", true],
    ["{*.ts,*.js}", "a.js", true],
    ["{*.ts,*.js}", "a.md", false],
    ["test/*/*.test.ts", "test/a/b.test.ts", true],
    ["test/*/*.test.ts", "test/a/b.js", false],
    // Regex metacharacters in a filename are literal.
    ["a.c", "a.c", true],
    ["a.c", "axc", false],
    ["a+c", "a+c", true],
    ["(x)", "(x)", true],
    ["[a+b].ts", "a+b.ts", false],
    ["[a+b].ts", "a.ts", true],
  ])("%s vs %s -> %s", (pattern, path, expected) => {
    expect(matchesGlob(path, pattern)).toBe(expected);
  });

  it("matches a Windows-style separator, since paths arrive both ways", () => {
    expect(matchesGlob("src\\a.ts", "*.ts")).toBe(true);
  });

  it("ignores surrounding whitespace in a pattern", () => {
    expect(matchesGlob("a.ts", "  *.ts  ")).toBe(true);
  });

  it("reports an unbalanced class or brace instead of loosening the pattern", () => {
    // A silently-widened pattern turns "find my config" into "find everything".
    expect(() => globToRegExp("a[bc")).toThrow(/unbalanced \[/u);
    expect(() => globToRegExp("a{b,c")).toThrow(/unbalanced \{/u);
    expect(() => globToRegExp("")).toThrow(/empty/u);
  });
});
