import { afterEach, describe, expect, it } from "vitest";
import {
  isAndroidHostPlatform,
  isAndroidWithoutTermux,
  isTermuxEnv,
  isTermuxHost,
  readTermuxHostInfo,
  resetTermuxHostStateForTests,
  resolveTermuxHomeFromPrefix,
  resolveTermuxPrefix,
} from "./termux.ts";

const TERMUX_PREFIX = "/data/data/com.termux/files/usr";
const TERMUX_HOME = "/data/data/com.termux/files/home";

/** A Termux environment as the app actually exports it. */
function termuxEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PREFIX: TERMUX_PREFIX,
    ANDROID_DATA: "/data",
    ANDROID_ROOT: "/system",
    HOME: TERMUX_HOME,
    ...overrides,
  };
}

afterEach(() => {
  resetTermuxHostStateForTests();
});

describe("isAndroidHostPlatform", () => {
  it("accepts only the Android platform Node reports", () => {
    expect(isAndroidHostPlatform("android")).toBe(true);
    for (const platform of ["linux", "darwin", "win32", "freebsd", "aix", "sunos"]) {
      expect(isAndroidHostPlatform(platform)).toBe(false);
    }
  });

  it("trims and rejects placeholder values", () => {
    expect(isAndroidHostPlatform("  android  ")).toBe(true);
    expect(isAndroidHostPlatform("")).toBe(false);
    expect(isAndroidHostPlatform("undefined")).toBe(false);
    expect(isAndroidHostPlatform("null")).toBe(false);
  });

  it("does not treat Android as Linux", () => {
    // The desktop host's failure mode: 112 `=== "linux"` branches, none for
    // `android`. A phone must never satisfy a Linux check.
    expect(isAndroidHostPlatform("android")).toBe(true);
    expect(isAndroidHostPlatform("linux")).toBe(false);
  });
});

describe("resolveTermuxPrefix", () => {
  it("accepts the Termux app prefix", () => {
    expect(resolveTermuxPrefix(termuxEnv())).toBe(TERMUX_PREFIX);
  });

  it("accepts a trailing slash", () => {
    expect(resolveTermuxPrefix(termuxEnv({ PREFIX: `${TERMUX_PREFIX}/` }))).toBe(TERMUX_PREFIX);
  });

  it("normalizes Windows-style separators before matching", () => {
    expect(
      resolveTermuxPrefix(termuxEnv({ PREFIX: TERMUX_PREFIX.replaceAll("/", "\\") })),
    ).toBe(TERMUX_PREFIX);
  });

  it("accepts a secondary-profile Termux prefix", () => {
    const prefix = "/data/user/10/com.termux/files/usr";
    expect(resolveTermuxPrefix(termuxEnv({ PREFIX: prefix }))).toBe(prefix);
  });

  it("rejects a path that only mentions com.termux outside the app root", () => {
    expect(resolveTermuxPrefix(termuxEnv({ PREFIX: "/tmp/com.termux/usr" }))).toBeUndefined();
    expect(resolveTermuxPrefix(termuxEnv({ PREFIX: "/tmp/com.termux/files/usrx" }))).toBeUndefined();
  });

  it("rejects a generic Linux prefix", () => {
    expect(resolveTermuxPrefix({ PREFIX: "/usr", ANDROID_DATA: "/data" })).toBeUndefined();
    expect(resolveTermuxPrefix({ PREFIX: "/usr/local" })).toBeUndefined();
  });

  it("rejects absent and placeholder values", () => {
    expect(resolveTermuxPrefix({})).toBeUndefined();
    expect(resolveTermuxPrefix({ PREFIX: "   " })).toBeUndefined();
    expect(resolveTermuxPrefix({ PREFIX: "undefined" })).toBeUndefined();
    expect(resolveTermuxPrefix({ PREFIX: "null" })).toBeUndefined();
  });
});

describe("isTermuxEnv", () => {
  it("requires both PREFIX and ANDROID_DATA", () => {
    expect(isTermuxEnv(termuxEnv())).toBe(true);
    expect(isTermuxEnv({ PREFIX: TERMUX_PREFIX })).toBe(false);
    expect(isTermuxEnv({ ANDROID_DATA: "/data" })).toBe(false);
    expect(isTermuxEnv({})).toBe(false);
  });

  it("does not mistake a generic chroot for Termux", () => {
    expect(isTermuxEnv({ PREFIX: "/usr", ANDROID_DATA: "/data" })).toBe(false);
  });
});

describe("isTermuxHost", () => {
  it("detects Termux from the Android platform alone", () => {
    // Termux:Boot and `sv` services can start with a stripped environment.
    expect(isTermuxHost({ platform: "android", env: {} })).toBe(true);
  });

  it("detects Termux from the environment on a linux-reporting runtime", () => {
    expect(isTermuxHost({ platform: "linux", env: termuxEnv() })).toBe(true);
  });

  it("rejects desktop Linux", () => {
    expect(isTermuxHost({ platform: "linux", env: { PREFIX: "/usr", HOME: "/home/u" } })).toBe(
      false,
    );
  });

  it("rejects macOS and Windows regardless of environment", () => {
    expect(isTermuxHost({ platform: "darwin", env: termuxEnv({ PREFIX: "/usr" }) })).toBe(false);
    expect(isTermuxHost({ platform: "win32", env: {} })).toBe(false);
  });

  it("caches the process-environment result and clears on reset", () => {
    const previousPlatform = process.platform;
    const previousPrefix = process.env.PREFIX;
    const previousAndroidData = process.env.ANDROID_DATA;
    try {
      Object.defineProperty(process, "platform", { value: "android", configurable: true });
      delete process.env.PREFIX;
      delete process.env.ANDROID_DATA;
      expect(isTermuxHost()).toBe(true);
      // A cached true must survive the environment being taken away.
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(isTermuxHost()).toBe(true);
      resetTermuxHostStateForTests();
      expect(isTermuxHost()).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", {
        value: previousPlatform,
        configurable: true,
      });
      if (previousPrefix !== undefined) {
        process.env.PREFIX = previousPrefix;
      }
      if (previousAndroidData !== undefined) {
        process.env.ANDROID_DATA = previousAndroidData;
      }
      resetTermuxHostStateForTests();
    }
  });

  it("never caches an explicitly parameterized probe", () => {
    expect(isTermuxHost({ platform: "android", env: {} })).toBe(true);
    expect(isTermuxHost({ platform: "linux", env: {} })).toBe(false);
  });
});

describe("isAndroidWithoutTermux", () => {
  it("isolates a bare Android Node build", () => {
    expect(isAndroidWithoutTermux({ platform: "android", env: {} })).toBe(true);
    expect(isAndroidWithoutTermux({ platform: "android", env: termuxEnv() })).toBe(false);
    expect(isAndroidWithoutTermux({ platform: "linux", env: termuxEnv() })).toBe(false);
  });
});

describe("readTermuxHostInfo", () => {
  it("reports the platform signal first", () => {
    expect(readTermuxHostInfo({ platform: "android", env: termuxEnv() })).toEqual({
      isTermux: true,
      isAndroidPlatform: true,
      prefix: TERMUX_PREFIX,
      home: TERMUX_HOME,
      signal: "android-platform",
    });
  });

  it("reports the environment signal on a linux-reporting runtime", () => {
    expect(readTermuxHostInfo({ platform: "linux", env: termuxEnv() })).toEqual({
      isTermux: true,
      isAndroidPlatform: false,
      prefix: TERMUX_PREFIX,
      home: TERMUX_HOME,
      signal: "termux-env",
    });
  });

  it("omits prefix and home when the contract does not hold", () => {
    const info = readTermuxHostInfo({ platform: "android", env: {} });
    expect(info).toEqual({
      isTermux: true,
      isAndroidPlatform: true,
      signal: "android-platform",
    });
    expect("prefix" in info).toBe(false);
    expect("home" in info).toBe(false);
  });

  it("reports none for a desktop host", () => {
    expect(readTermuxHostInfo({ platform: "linux", env: { PREFIX: "/usr" } })).toEqual({
      isTermux: false,
      isAndroidPlatform: false,
      signal: "none",
    });
  });
});

describe("resolveTermuxHomeFromPrefix", () => {
  it("derives home from the Termux prefix", () => {
    expect(resolveTermuxHomeFromPrefix(TERMUX_PREFIX)).toBe(TERMUX_HOME);
    expect(resolveTermuxHomeFromPrefix(`${TERMUX_PREFIX}/`)).toBe(TERMUX_HOME);
  });

  it("handles a secondary-profile prefix", () => {
    expect(resolveTermuxHomeFromPrefix("/data/user/10/com.termux/files/usr")).toBe(
      "/data/user/10/com.termux/files/home",
    );
  });
});
