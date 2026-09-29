// Splits a command line into argv, because ClawAgent never runs a shell.
//
// `child_process.spawn(command, { shell: true })` would hand every tool call to
// `/bin/sh` — which does not exist on Termux, where the shell is `/data/data/
// com.termux/files/usr/bin/bash`. Beyond being wrong on the target device, a
// shell means any text from a model becomes syntax: `; rm -rf`, `$(...)`,
// backticks. Refusing to parse operators is the point of this file, not a
// limitation to apologise for. A model that needs a pipeline gets a clear error
// and can chain commands with a tool that exists, or ask the user to approve a
// shell out of band.
//
// Supported: words, single quotes (literal), double quotes (backslash escapes
// for `\$`\" ), and backslash escapes outside quotes.

/**
 * Operators this parser refuses, mapped to what to do instead.
 *
 * Order is load-bearing and is therefore not left to whoever edits this list: the
 * longest operator must be tested first, or `a || b` is reported as containing
 * `|` and comes with the hint for a pipe. Same for `&&` against `&`, and for the
 * `>` inside `2>`. The sort lives in {@link REFUSED_FIRST}, so the list below can
 * stay in the order a person reads it in.
 */
const REFUSED_OPERATORS: ReadonlyArray<readonly [string, string]> = [
  ["|", "run the two commands separately and pass the first command's output as an argument, or use a tool that takes a filter"],
  ["||", "run the commands separately"],
  ["&&", "run the commands separately, one tool call each"],
  ["&", "background execution is not supported; a long-running command will time out instead"],
  [";", "run the commands separately, one tool call each"],
  [">", "output redirection is not supported; return the output and use write"],
  ["<", "input redirection is not supported; pass arguments directly instead"],
  ["2>", "stderr is already captured separately; no redirection is needed"],
  ["`", "command substitution is not supported"],
  ["$(", "command substitution is not supported"],
  ["$", "variable expansion is not supported; pass literal values"],
  ["\n", "put one command per call"],
];

/** {@link REFUSED_OPERATORS} with the longest operator first, which is what the scan uses. */
const REFUSED_FIRST: readonly (readonly [string, string])[] = [...REFUSED_OPERATORS].sort(
  (left, right) => right[0].length - left[0].length,
);

export type SplitResult =
  | { ok: true; argv: string[] }
  | { ok: false; error: string; hint?: string };

export function splitCommandLine(input: string): SplitResult {
  const source = input.trim();
  if (!source) {
    return { ok: false, error: "command is empty", hint: "pass a program and its arguments" };
  }
  for (const [operator, alternative] of REFUSED_FIRST) {
    const found = findUnquoted(source, operator);
    if (found >= 0) {
      return {
        ok: false,
        error: `unsupported shell operator "${operator}" in command`,
        hint: alternative,
      };
    }
  }

  const argv: string[] = [];
  let current = "";
  let started = false;
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "'") {
      started = true;
      const close = source.indexOf("'", index + 1);
      if (close < 0) {
        return { ok: false, error: "unterminated single quote in command", hint: "close the quote" };
      }
      current += source.slice(index + 1, close);
      index = close + 1;
      continue;
    }
    if (char === '"') {
      started = true;
      index += 1;
      while (index < source.length && source[index] !== '"') {
        const inner = source[index] as string;
        if (inner === "\\" && index + 1 < source.length) {
          const next = source[index + 1] as string;
          current += next === '"' || next === "\\" || next === "$" || next === "`" ? next : `\\${next}`;
          index += 2;
          continue;
        }
        current += inner;
        index += 1;
      }
      if (index >= source.length) {
        return { ok: false, error: "unterminated double quote in command", hint: "close the quote" };
      }
      index += 1;
      continue;
    }
    if (char === "\\" && index + 1 < source.length) {
      started = true;
      current += source[index + 1];
      index += 2;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      index += 1;
      continue;
    }
    started = true;
    current += char;
    index += 1;
  }
  if (started) {
    argv.push(current);
  }
  if (argv.length === 0) {
    return { ok: false, error: "command is empty", hint: "pass a program and its arguments" };
  }
  return { ok: true, argv };
}

/**
 * Index of `needle` outside quotes, or -1.
 *
 * Quoted operators are data, so `echo "a | b"` is fine while `echo a | b` is
 * not. That distinction is the whole reason this is a parser and not a `split`.
 */
function findUnquoted(source: string, needle: string): number {
  let quote: string | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (source.startsWith(needle, index)) {
      return index;
    }
  }
  return -1;
}
