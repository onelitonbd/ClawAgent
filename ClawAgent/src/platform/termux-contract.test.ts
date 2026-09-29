// Cross-package agreement test.
//
// `platform/termux.ts` carries a deliberate local copy of the Termux detection
// contract so it can load before any workspace package resolves. This file is
// what makes that copy safe: it fails loudly if the home-dir owner in
// `@openclaw/normalization-core` and the host owner here ever disagree.
//
// It imports a workspace package on purpose. If dependencies are not installed
// this file errors rather than silently passing, which is the correct behaviour
// for a contract test.
import { describe, expect, it } from "vitest";
import { resolveOsHomeDir } from "@openclaw/normalization-core/home-dir";
import { resolveTermuxHomeFromPrefix, resolveTermuxPrefix } from "./termux.ts";

const TERMUX_PREFIX = "/data/data/com.termux/files/usr";
const TERMUX_HOME = "/data/data/com.termux/files/home";

/**
 * A homedir stub that throws, for cases where `$PREFIX` *should* decide.
 *
 * If either owner wrongly falls back to `os.homedir()` here, the test fails with
 * a loud error rather than passing on a coincidentally equal value.
 */
function unavailableHomedir(): string {
  throw new Error("os.homedir() must not decide a Termux home");
}

/** A home value that could never be produced by Termux derivation. */
const SENTINEL_HOME = "/sentinel/os-homedir";

/**
 * A homedir stub that records whether it was consulted and returns a sentinel.
 *
 * Used for the negative cases. `resolveOsHomeDir` deliberately never throws —
 * it catches a failing `os.homedir()` and returns `undefined` — so "the owner
 * refused to derive a Termux home" has to be asserted by showing that the call
 * fell all the way through to `os.homedir()` and produced something that is not
 * a Termux path. Asserting a throw here would be asserting a contract the owner
 * does not have.
 */
function recordingHomedir(calls: { count: number }): () => string {
  return () => {
    calls.count += 1;
    return SENTINEL_HOME;
  };
}

describe("Termux home derivation agrees with normalization-core", () => {
  it("resolves the same home from PREFIX when HOME is absent", () => {
    const env: NodeJS.ProcessEnv = { PREFIX: TERMUX_PREFIX, ANDROID_DATA: "/data" };
    expect(resolveOsHomeDir(env, unavailableHomedir)).toBe(TERMUX_HOME);
    const prefix = resolveTermuxPrefix(env);
    expect(prefix).toBe(TERMUX_PREFIX);
    expect(resolveTermuxHomeFromPrefix(prefix as string)).toBe(TERMUX_HOME);
  });

  it("resolves the same home for a secondary-profile prefix", () => {
    const prefix = "/data/user/10/com.termux/files/usr";
    const env: NodeJS.ProcessEnv = { PREFIX: prefix, ANDROID_DATA: "/data" };
    expect(resolveOsHomeDir(env, unavailableHomedir)).toBe("/data/user/10/com.termux/files/home");
    expect(resolveTermuxHomeFromPrefix(resolveTermuxPrefix(env) as string)).toBe(
      "/data/user/10/com.termux/files/home",
    );
  });

  it("accepts and rejects the same PREFIX values", () => {
    const accepted = [
      TERMUX_PREFIX,
      `${TERMUX_PREFIX}/`,
      "/data/user/10/com.termux/files/usr",
    ];
    const rejected = [
      // Mentioning com.termux outside the app root must not match.
      "/tmp/com.termux/usr",
      "/tmp/com.termux/files/usrx",
      "/usr",
      "/usr/local",
      "",
      "   ",
      "undefined",
      "null",
    ];
    for (const prefix of accepted) {
      const env: NodeJS.ProcessEnv = { PREFIX: prefix, ANDROID_DATA: "/data" };
      expect(
        resolveTermuxPrefix(env),
        `expected both owners to accept PREFIX=${prefix}`,
      ).toBeDefined();
      expect(resolveOsHomeDir(env, unavailableHomedir)).toBe(
        resolveTermuxHomeFromPrefix(resolveTermuxPrefix(env) as string),
      );
    }
    for (const prefix of rejected) {
      const env: NodeJS.ProcessEnv = { PREFIX: prefix, ANDROID_DATA: "/data" };
      expect(resolveTermuxPrefix(env), `expected PREFIX=${prefix} to be rejected`).toBeUndefined();
      // With no usable PREFIX and no HOME, the home-dir owner must fall all the
      // way through to os.homedir() rather than inventing a Termux home.
      const calls = { count: 0 };
      const resolved = resolveOsHomeDir(env, recordingHomedir(calls));
      expect(calls.count, `PREFIX=${prefix} must not short-circuit os.homedir()`).toBe(1);
      expect(resolved, `PREFIX=${prefix} must not derive a home`).toBe(SENTINEL_HOME);
    }
  });

  it("requires ANDROID_DATA in both owners", () => {
    const env: NodeJS.ProcessEnv = { PREFIX: TERMUX_PREFIX };
    expect(resolveTermuxPrefix(env)).toBe(TERMUX_PREFIX);
    // The host owner gates on ANDROID_DATA through isTermuxEnv(); the home-dir
    // owner gates the same way, so neither may resolve a Termux home here. A
    // valid PREFIX alone is not enough, which matters because desktop shells
    // commonly export PREFIX for unrelated reasons.
    const calls = { count: 0 };
    const resolved = resolveOsHomeDir(env, recordingHomedir(calls));
    expect(calls.count).toBe(1);
    expect(resolved).toBe(SENTINEL_HOME);
    expect(resolved).not.toBe(TERMUX_HOME);
  });

  it("prefers an explicit HOME in both owners", () => {
    const env: NodeJS.ProcessEnv = {
      PREFIX: TERMUX_PREFIX,
      ANDROID_DATA: "/data",
      HOME: "/data/data/com.termux/files/home/custom",
    };
    expect(resolveOsHomeDir(env, unavailableHomedir)).toBe(
      "/data/data/com.termux/files/home/custom",
    );
    // PREFIX derivation is unchanged; HOME precedence belongs to the config layer.
    expect(resolveTermuxHomeFromPrefix(resolveTermuxPrefix(env) as string)).toBe(TERMUX_HOME);
  });
});
