// Splitting a command line without a shell.
//
// The refusals matter more than the accepts: every operator that slips through
// here is a channel from model-authored text to whatever `/bin/sh` would have
// done with it — and on Termux there is no `/bin/sh` to blame, which is precisely
// why the tool must not pretend there is one.

import { describe, expect, it } from "vitest";
import { splitCommandLine } from "./command-argv.ts";

const argv = (input: string): string[] | undefined => {
  const result = splitCommandLine(input);
  return result.ok ? result.argv : undefined;
};

describe("splitCommandLine", () => {
  it.each([
    ["git status --short", ["git", "status", "--short"]],
    ['echo "hello world"', ["echo", "hello world"]],
    ["echo 'a | b'", ["echo", "a | b"]],
    ["node -e \"process.exit(1)\"", ["node", "-e", "process.exit(1)"]],
    ["ls  a   b ", ["ls", "a", "b"]],
    ["termux-battery-status", ["termux-battery-status"]],
    ["./tools/run.sh --flag=value", ["./tools/run.sh", "--flag=value"]],
    ["echo a\\ b", ["echo", "a b"]],
    ['echo "quote: \\""', ["echo", 'quote: "']],
    ["find . -name '*.ts'", ["find", ".", "-name", "*.ts"]],
  ])("splits %j", (input, expected) => {
    expect(argv(input)).toEqual(expected);
  });

  it("keeps a glob unexpanded, because no shell is involved", () => {
    // Expanding it would be a second behaviour difference to explain; the tools
    // that take patterns do their own matching.
    expect(argv("ls *.ts")).toEqual(["ls", "*.ts"]);
  });

  it.each([
    ["ls | cat", "|"],
    ["a && b", "&&"],
    ["a || b", "||"],
    ["sleep 1 &", "&"],
    ["echo hi > f", ">"],
    ["echo hi < f", "<"],
    ["echo $(whoami)", "$("],
    ["echo `date`", "`"],
    ["echo $HOME", "$"],
    ["a; b", ";"],
    ["a\nb", "\n"],
  ])("refuses %j for containing %j", (input, operator) => {
    const result = splitCommandLine(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(operator.trim() === "" ? "operator" : operator);
      // Refusing without an alternative is how a model retries the same call.
      expect(result.hint).toBeTruthy();
    }
  });

  it("allows an operator inside quotes, because there it is data", () => {
    expect(argv('git commit -m "fix: a | b"')).toEqual(["git", "commit", "-m", "fix: a | b"]);
    expect(argv("grep ';' file.txt")).toEqual(["grep", ";", "file.txt"]);
  });

  it("reports an unterminated quote", () => {
    const result = splitCommandLine("echo 'oops");
    expect(!result.ok && result.error).toContain("unterminated single quote");
    const double = splitCommandLine('echo "oops');
    expect(!double.ok && double.error).toContain("unterminated double quote");
  });

  it("reports an empty command", () => {
    expect(!splitCommandLine("   ").ok).toBe(true);
    const result = splitCommandLine("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty");
    }
  });
});
