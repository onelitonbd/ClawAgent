// Output stream shapes.
//
// Its own module because command modules and the dispatcher both need it. If it
// lived in `main.ts`, `chat.ts` would import the dispatcher that imports `chat.ts`
// — an erasable type-only cycle today, and a real one the moment anyone needs a
// value from here.

/** Minimal write target, so tests can capture output without a TTY. */
export type OutputStream = { write(chunk: string): unknown };

/** Writes lines, appending a newline to each. */
export function writeLines(stream: OutputStream, lines: readonly string[]): void {
  for (const line of lines) {
    stream.write(`${line}\n`);
  }
}

/** True when the stream is an interactive terminal. */
export function isTTY(stream: OutputStream | undefined): boolean {
  return Boolean((stream as { isTTY?: boolean } | undefined)?.isTTY);
}
