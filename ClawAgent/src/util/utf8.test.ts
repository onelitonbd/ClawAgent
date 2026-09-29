// Text detection and decoding, which decides what counts as "a file a model can
// read". The failure mode being avoided is a binary rendered as a wall of
// replacement characters and passed off as source code.

import { describe, expect, it } from "vitest";
import { decodeUtf8Strict, looksBinary, tryDecodeUtf8 } from "./utf8.ts";

describe("looksBinary", () => {
  it("is true for a NUL in the probe window and false without one", () => {
    expect(looksBinary(Buffer.from([0x00, 0x41]))).toBe(true);
    expect(looksBinary(Buffer.from("plain text"))).toBe(false);
  });

  it("only inspects the head of the file", () => {
    // A 4 MiB media file must cost the same to classify as a 40-byte one, so a
    // NUL past the probe window is deliberately not found.
    const body = Buffer.alloc(16_384, 0x41);
    body[12_000] = 0;
    expect(looksBinary(body)).toBe(false);
    const early = Buffer.alloc(16_384, 0x41);
    early[100] = 0;
    expect(looksBinary(early)).toBe(true);
  });
});

describe("decodeUtf8Strict", () => {
  it("decodes valid UTF-8 including multi-byte text", () => {
    expect(decodeUtf8Strict(Buffer.from("héllo wörld — ✓", "utf8"))).toBe("héllo wörld — ✓");
  });

  it("throws on invalid UTF-8 instead of substituting U+FFFD", () => {
    // The default TextDecoder would return a string full of `\uFFFD`, which a
    // model then quotes back as if it were the file's contents.
    expect(() => decodeUtf8Strict(Buffer.from([0xc3, 0x28, 0xa0]))).toThrow(/not valid UTF-8/u);
  });

  it("strips a byte-order mark so it cannot corrupt the first token", () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const a = 1;")]);
    expect(decodeUtf8Strict(withBom)).toBe("export const a = 1;");
  });
});

describe("tryDecodeUtf8", () => {
  it("reports failure as undefined, for a caller that is skipping files", () => {
    expect(tryDecodeUtf8(Buffer.from([0xc3, 0x28]))).toBeUndefined();
    expect(tryDecodeUtf8(Buffer.from([0x00, 0x01]))).toBeUndefined();
    expect(tryDecodeUtf8(Buffer.from("fine", "utf8"))).toBe("fine");
  });
});
