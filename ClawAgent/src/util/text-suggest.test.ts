import { describe, expect, it } from "vitest";
import { editDistance, maskSecret, suggestName } from "./text-suggest.ts";

describe("editDistance", () => {
  it.each([
    ["", "", 0],
    ["abc", "abc", 0],
    ["abc", "abd", 1],
    ["abc", "ab", 1],
    ["abc", "abcd", 1],
    ["doctor", "doctr", 1],
    ["kitten", "sitting", 3],
  ])("distance(%j, %j) === %d", (a, b, expected) => {
    expect(editDistance(a, b)).toBe(expected);
  });

  it("gives up past the limit", () => {
    expect(editDistance("a".repeat(50), "b".repeat(50), 3)).toBe(4);
  });

  it("short-circuits on a length gap wider than the limit", () => {
    // The early exit returns limit + 1 rather than a real distance. Callers only
    // compare against a small threshold, so "definitely not close" is enough.
    expect(editDistance("ab", "a".repeat(40), 5)).toBe(6);
  });
});

describe("suggestName", () => {
  const NAMES = ["anthropic", "openai", "google", "mistral", "openai-compatible"];

  it("returns an exact match unchanged", () => {
    expect(suggestName("openai", NAMES)).toBe("openai");
  });

  it("matches case-insensitively", () => {
    expect(suggestName("Anthropic", NAMES)).toBe("anthropic");
  });

  it("suggests on a prefix", () => {
    expect(suggestName("anthro", NAMES)).toBe("anthropic");
  });

  it("suggests on a close typo", () => {
    expect(suggestName("antropic", NAMES)).toBe("anthropic");
    expect(suggestName("opnai", NAMES)).toBe("openai");
  });

  it("refuses to guess when nothing is close", () => {
    expect(suggestName("bedrock-converse", NAMES)).toBeUndefined();
  });

  it("does not suggest from a single character", () => {
    // One character prefixes almost everything, so a suggestion would be noise.
    expect(suggestName("a", NAMES)).toBeUndefined();
  });

  it("returns undefined for an empty candidate list", () => {
    expect(suggestName("anthropic", [])).toBeUndefined();
  });
});

describe("maskSecret", () => {
  it("keeps only the tail of a long key", () => {
    expect(maskSecret("sk-ant-api03-ABCDEFGHIJKLMNOP")).toBe("****MNOP");
  });

  it("masks a short value entirely", () => {
    // Revealing the last four of an eight-character secret reveals half of it.
    expect(maskSecret("abcdefgh")).toBe("********");
  });

  it("returns an empty string for blank input", () => {
    expect(maskSecret("   ")).toBe("");
  });

  it("honours a custom keep length", () => {
    expect(maskSecret("sk-ant-api03-ABCDEFGHIJKLMNOP", 2)).toBe("**OP");
  });

  it("never leaks the head of the key", () => {
    const key = "sk-ant-api03-ABCDEFGHIJKLMNOP";
    const masked = maskSecret(key);
    expect(masked).not.toContain("sk-ant");
    expect(masked).toContain(key.slice(-4));
  });
});
