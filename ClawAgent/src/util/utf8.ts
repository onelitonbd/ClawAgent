// Text decoding and "is this a text file", in one place.
//
// `Buffer.isUtf8` is the obvious API, but on the Node line this host's floor
// allows it is exported from `node:buffer` as a function rather than as a
// `Buffer` static, which is the kind of detail that reads fine on a laptop and
// throws `is not a function` on a phone. `TextDecoder` with `fatal: true` has
// been stable far longer and does two jobs at once: it validates the bytes and
// produces the string, so a file is decoded exactly one time.
//
// Binary detection is deliberately shallow. A NUL byte in the first few
// kilobytes is what every real `grep` uses to mean "binary", and the alternative
// — trying to decode the whole file — turns a 200 MiB media file into a
// multi-second stall on a device that cannot afford it.

/** Bytes examined for a NUL before a file is called binary. */
const BINARY_PROBE_BYTES = 8192;

export function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, Math.min(buffer.length, BINARY_PROBE_BYTES));
  return probe.indexOf(0) >= 0;
}

/**
 * Decodes UTF-8, refusing invalid input instead of substituting U+FFFD.
 *
 * The replacement character is the trap: `TextDecoder` in its default mode
 * happily turns a JPEG into a string of `` that a model then quotes back as if
 * it were source code.
 */
export function decodeUtf8Strict(buffer: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("file is not valid UTF-8 text");
  }
  return stripBom(text);
}

/** Like {@link decodeUtf8Strict}, but reports failure as `undefined` for skipping. */
export function tryDecodeUtf8(buffer: Buffer): string | undefined {
  if (looksBinary(buffer)) {
    return undefined;
  }
  try {
    return stripBom(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    return undefined;
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
