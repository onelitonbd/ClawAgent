// Anti-drift contract tests for the path rules ClawAgent reimplements locally.
//
// ClawAgent cannot import `@openclaw/normalization-core` at runtime (workspace
// packages use `.js` specifiers, which Node's type-stripping loader cannot
// resolve against `.ts` sources), so `src/config/paths.ts` duplicates the
// home-dir and agent-id rules. These tests are what make that duplication safe:
// they compare ClawAgent's implementation against the real package across every
// environment the mobile host has to survive, and fail the moment the two
// disagree.
//
// If normalization-core changes, this file fails and ClawAgent must follow.
// That is the point.

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeAgentId as normalizeAgentIdUpstream,
  isValidAgentId as isValidAgentIdUpstream,
} from "@openclaw/normalization-core/agent-id";
import {
  normalizeHomeDirValue as normalizeHomeDirValueUpstream,
  resolveOsHomeDir as resolveOsHomeDirUpstream,
} from "@openclaw/normalization-core/home-dir";
import {
  normalizeAgentId,
  isValidAgentId,
  normalizeHomeDirValue,
  resolveOsHomeDir,
} from "./paths.ts";

// A homedir stub that mimics Node on Termux: `os.homedir()` reads `$HOME` and
// falls back to a platform-specific guess that is wrong on Android.
function stubHomedir(value: string | undefined) {
  return () => {
    if (value === undefined) {
      // Mirrors the real failure mode: Node returns `$PREFIX/home`, a path that
      // does not exist when `HOME` is unset.
      return "/data/data/com.termux/files/usr/home";
    }
    return value;
  };
}

const HOME_CASES: ReadonlyArray<{
  name: string;
  env: NodeJS.ProcessEnv;
  homedir: string | undefined;
}> = [
  { name: "plain HOME", env: { HOME: "/home/user" }, homedir: "/home/user" },
  { name: "HOME with whitespace", env: { HOME: "  /home/user  " }, homedir: "/home/user" },
  { name: "USERPROFILE fallback", env: { USERPROFILE: "C:\\Users\\dev" }, homedir: undefined },
  { name: "HOME wins over USERPROFILE", env: { HOME: "/home/user", USERPROFILE: "C:\\Users\\dev" }, homedir: "/home/user" },
  { name: "empty HOME", env: { HOME: "" }, homedir: "/fallback" },
  { name: "whitespace-only HOME", env: { HOME: "   " }, homedir: "/fallback" },
  { name: 'literal "undefined" HOME', env: { HOME: "undefined" }, homedir: "/fallback" },
  { name: 'literal "null" HOME', env: { HOME: "null" }, homedir: "/fallback" },
  { name: "no env at all", env: {}, homedir: undefined },
  {
    name: "Termux: PREFIX only (desktop shell, must not relocate)",
    env: { PREFIX: "/data/data/com.termux/files/usr" },
    homedir: "/fallback",
  },
  {
    name: "Termux: PREFIX + ANDROID_DATA, no HOME",
    env: {
      PREFIX: "/data/data/com.termux/files/usr",
      ANDROID_DATA: "/data",
    },
    homedir: undefined,
  },
  {
    name: "Termux: PREFIX with trailing slash",
    env: {
      PREFIX: "/data/data/com.termux/files/usr/",
      ANDROID_DATA: "/data",
    },
    homedir: undefined,
  },
  {
    name: "Termux: HOME set wins over PREFIX derivation",
    env: {
      HOME: "/data/data/com.termux/files/home",
      PREFIX: "/data/data/com.termux/files/usr",
      ANDROID_DATA: "/data",
    },
    homedir: undefined,
  },
  {
    name: "Termux-like PREFIX under a different package name",
    env: { PREFIX: "/data/data/com.other/files/usr", ANDROID_DATA: "/data" },
    homedir: "/fallback",
  },
];

describe("home directory rules match @openclaw/normalization-core", () => {
  it.each(HOME_CASES)("$name", ({ env, homedir }) => {
    const stub = stubHomedir(homedir);
    expect(resolveOsHomeDir(env, stub)).toBe(resolveOsHomeDirUpstream(env, stub));
  });
});

describe("normalizeHomeDirValue matches @openclaw/normalization-core", () => {
  it.each([
    undefined,
    "",
    "   ",
    "undefined",
    "null",
    "/data/data/com.termux/files/home",
    "  /home/user  ",
    "~",
  ])("agrees for %j", (value) => {
    expect(normalizeHomeDirValue(value)).toBe(normalizeHomeDirValueUpstream(value));
  });
});

const AGENT_ID_CASES = [
  "main",
  "Main",
  "MAIN",
  "agent-1",
  "agent_1",
  "a",
  "0",
  "",
  "   ",
  "-leading",
  "trailing-",
  "..",
  "../etc",
  "../../etc/passwd",
  "has space",
  "has/slash",
  "has.dot",
  "has\\backslash",
  "héllo",
  "a".repeat(64),
  "a".repeat(65),
  "a".repeat(200),
  "---",
  "!!!",
];

describe("agent id rules match @openclaw/normalization-core", () => {
  it.each(AGENT_ID_CASES)("isValidAgentId agrees for %j", (value) => {
    expect(isValidAgentId(value)).toBe(isValidAgentIdUpstream(value));
  });

  it.each(AGENT_ID_CASES)("normalizeAgentId agrees for %j", (value) => {
    const upstream = normalizeAgentIdUpstream(value);
    const local = normalizeAgentId(value);
    // ClawAgent intentionally does not fall back to "main": an unrepresentable
    // id returns undefined here and `err("unrepresentable")` upstream. Both
    // mean "no usable id", so the contract is: local is undefined exactly when
    // upstream signals failure, and identical otherwise.
    if (local === undefined) {
      expect(upstream).toBe("main");
      expect(isValidAgentIdUpstream(value)).toBe(false);
    } else {
      expect(local).toBe(upstream);
    }
  });

  it("never produces a path-escaping agent directory name", () => {
    for (const value of AGENT_ID_CASES) {
      const normalized = normalizeAgentId(value);
      if (!normalized) {
        continue;
      }
      expect(path.resolve("/state/agents", normalized)).toBe(
        path.join("/state/agents", normalized),
      );
      expect(normalized).not.toContain(".");
      expect(normalized).not.toContain(path.sep);
    }
  });
});
