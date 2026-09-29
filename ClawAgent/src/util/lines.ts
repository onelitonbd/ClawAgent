/**
 * Lines of text in a file body.
 *
 * One definition, shared by the `write` tool's result and the approval prompt,
 * because those two are shown for the same content one screen apart. Counting a
 * trailing newline as an extra line in one of them would make the prompt say
 * "2 lines" and the result say "created … (1 lines)" for the same string, which
 * reads as one of the two lying.
 *
 * A body ending in "\n" is therefore N lines, not N+1 — matching what `wc -l`
 * reports and what a person means by "a four-line file".
 */
export function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** "1 line" / "3 lines", so counts read like English in both places. */
export function lineCount(count: number): string {
  return `${count} line${count === 1 ? "" : "s"}`;
}
