import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  TERMUX_API_COMMANDS,
  acquireWakeLock,
  isTermuxApiInstalled,
  probeTermuxApi,
  readTermuxBatteryStatus,
  releaseWakeLock,
  resolveTermuxCommand,
  runTermuxCommand,
} from "./termux-api.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clawagent-api-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Builds a fake `$PREFIX` containing executable stand-ins for Termux commands.
 *
 * The shebang uses `env` rather than an absolute interpreter path so these tests
 * keep working if they are ever run somewhere other than a CI Linux host.
 */
function fakePrefix(scripts: Record<string, string>): string {
  const prefix = tempDir();
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(prefix, "bin", name);
    writeFileSync(file, `#!/usr/bin/env sh\n${body}\n`, "utf8");
    chmodSync(file, 0o755);
  }
  return prefix;
}

function envFor(prefix: string): NodeJS.ProcessEnv {
  // An explicit PATH keeps the spawn independent of whatever the test runner set.
  return { PREFIX: prefix, PATH: process.env.PATH ?? "", ANDROID_DATA: "/data" };
}

describe("resolveTermuxCommand", () => {
  it("finds a command under $PREFIX/bin", () => {
    const prefix = fakePrefix({ "termux-wake-lock": "exit 0" });
    expect(resolveTermuxCommand("termux-wake-lock", envFor(prefix))).toBe(
      path.join(prefix, "bin", "termux-wake-lock"),
    );
  });

  it("finds a command on PATH when $PREFIX is unset", () => {
    const prefix = fakePrefix({ "termux-notification": "exit 0" });
    const bin = path.join(prefix, "bin");
    expect(
      resolveTermuxCommand("termux-notification", { PATH: `${bin}${path.delimiter}/nowhere` }),
    ).toBe(path.join(bin, "termux-notification"));
  });

  it("prefers $PREFIX over PATH", () => {
    // $PREFIX is authoritative for Termux packages; a stale PATH entry must not win.
    const prefix = fakePrefix({ "termux-open": "exit 0" });
    const other = fakePrefix({ "termux-open": "exit 0" });
    const resolved = resolveTermuxCommand("termux-open", {
      PREFIX: prefix,
      PATH: path.join(other, "bin"),
    });
    expect(resolved).toBe(path.join(prefix, "bin", "termux-open"));
  });

  it("returns undefined when the command is absent", () => {
    expect(resolveTermuxCommand("termux-wake-lock", { PATH: "/nonexistent-dir" })).toBeUndefined();
  });

  it("ignores a file that is not executable", () => {
    const prefix = tempDir();
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    const file = path.join(prefix, "bin", "termux-vibrate");
    writeFileSync(file, "exit 0", "utf8");
    chmodSync(file, 0o644);
    expect(resolveTermuxCommand("termux-vibrate", envFor(prefix))).toBeUndefined();
  });

  it("tolerates an empty or whitespace PREFIX", () => {
    expect(resolveTermuxCommand("termux-open", { PREFIX: "   ", PATH: "/nonexistent" })).toBeUndefined();
  });

  it("never builds a path from a hardcoded system directory", () => {
    // Resolution must come from the environment, so an absent PREFIX and an
    // empty PATH cannot accidentally produce /bin/termux-open.
    expect(resolveTermuxCommand("termux-open", {})).toBeUndefined();
  });
});

describe("probeTermuxApi", () => {
  it("reports every known command", () => {
    const prefix = fakePrefix({ "termux-wake-lock": "exit 0" });
    const probe = probeTermuxApi(envFor(prefix));
    expect(Object.keys(probe).sort()).toEqual([...TERMUX_API_COMMANDS].sort());
    expect(probe["termux-wake-lock"]).toBeTruthy();
    expect(probe["termux-notification"]).toBeUndefined();
  });

  it("drives isTermuxApiInstalled", () => {
    const installed = fakePrefix({ "termux-clipboard-set": "exit 0" });
    expect(isTermuxApiInstalled(envFor(installed))).toBe(true);
    expect(isTermuxApiInstalled({ PATH: "/nonexistent-dir" })).toBe(false);
  });
});

describe("runTermuxCommand", () => {
  it("reports not-installed without spawning", () => {
    const result = runTermuxCommand("termux-wake-lock", [], { env: { PATH: "/nonexistent-dir" } });
    expect(result).toMatchObject({ ok: false, status: null, reason: "not-installed" });
    expect(result.command).toBeUndefined();
  });

  it("captures stdout from a real command", () => {
    const prefix = fakePrefix({ "termux-clipboard-get": "printf 'hello'" });
    const result = runTermuxCommand("termux-clipboard-get", [], { env: envFor(prefix) });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("hello");
    expect(result.status).toBe(0);
    expect(result.command).toBe(path.join(prefix, "bin", "termux-clipboard-get"));
  });

  it("passes arguments through", () => {
    const prefix = fakePrefix({ "termux-notification": 'printf "%s" "$1-$2"' });
    const result = runTermuxCommand("termux-notification", ["--title", "body"], {
      env: envFor(prefix),
    });
    expect(result.stdout).toBe("--title-body");
  });

  it("reports a non-zero exit rather than throwing", () => {
    const prefix = fakePrefix({ "termux-tts-speak": "exit 3" });
    const result = runTermuxCommand("termux-tts-speak", [], { env: envFor(prefix) });
    expect(result).toMatchObject({ ok: false, status: 3, reason: "nonzero-exit" });
  });

  it("captures stderr from a failing command", () => {
    const prefix = fakePrefix({ "termux-open": "echo boom >&2; exit 1" });
    const result = runTermuxCommand("termux-open", [], { env: envFor(prefix) });
    expect(result.stderr).toContain("boom");
  });

  it("feeds stdin when given input", () => {
    const prefix = fakePrefix({ "termux-clipboard-set": "cat" });
    const result = runTermuxCommand("termux-clipboard-set", [], {
      env: envFor(prefix),
      input: "piped",
    });
    expect(result.stdout).toBe("piped");
  });

  it("times out instead of hanging forever", () => {
    // termux-api commands talk to the Android framework, which can block when
    // the companion app is missing or restricted.
    const prefix = fakePrefix({ "termux-vibrate": "sleep 5" });
    const started = Date.now();
    const result = runTermuxCommand("termux-vibrate", [], { env: envFor(prefix), timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("readTermuxBatteryStatus", () => {
  it("parses the JSON array termux-battery-status prints", () => {
    const prefix = fakePrefix({
      "termux-battery-status":
        "printf '%s' '[{\"percentage\":82,\"plugged\":\"USB\",\"health\":\"GOOD\",\"temperature\":31,\"present\":true}]'",
    });
    const status = readTermuxBatteryStatus({ env: envFor(prefix) });
    expect(status).toMatchObject({ available: true, percentage: 82, plugged: "USB", health: "GOOD", temperature: 31 });
  });

  it("accepts a bare object as well as an array", () => {
    const prefix = fakePrefix({
      "termux-battery-status": "printf '%s' '{\"percentage\":44}'",
    });
    expect(readTermuxBatteryStatus({ env: envFor(prefix) })).toMatchObject({
      available: true,
      percentage: 44,
    });
  });

  it("ignores fields that are missing or the wrong type", () => {
    const prefix = fakePrefix({
      "termux-battery-status": "printf '%s' '[{\"percentage\":\"full\",\"plugged\":\"AC\"}]'",
    });
    const status = readTermuxBatteryStatus({ env: envFor(prefix) });
    expect(status.available).toBe(true);
    expect(status.percentage).toBeUndefined();
    expect(status.plugged).toBe("AC");
  });

  it("reports unparsable output as unavailable with a reason", () => {
    const prefix = fakePrefix({ "termux-battery-status": "echo 'not json at all'" });
    expect(readTermuxBatteryStatus({ env: envFor(prefix) })).toEqual({
      available: false,
      reason: "unparsable",
    });
  });

  it("reports an empty array as unparsable", () => {
    const prefix = fakePrefix({ "termux-battery-status": "printf '%s' '[]'" });
    expect(readTermuxBatteryStatus({ env: envFor(prefix) })).toMatchObject({
      available: false,
      reason: "unparsable",
    });
  });

  it("propagates the reason when the command is missing", () => {
    expect(readTermuxBatteryStatus({ env: { PATH: "/nonexistent-dir" } })).toEqual({
      available: false,
      reason: "not-installed",
    });
  });

  it("propagates the reason when the command fails", () => {
    const prefix = fakePrefix({ "termux-battery-status": "exit 1" });
    expect(readTermuxBatteryStatus({ env: envFor(prefix) })).toMatchObject({
      available: false,
      reason: "nonzero-exit",
    });
  });
});

describe("wake lock", () => {
  it("acquires the lock through termux-wake-lock", () => {
    const prefix = fakePrefix({ "termux-wake-lock": "exit 0" });
    expect(acquireWakeLock({ env: envFor(prefix) }).ok).toBe(true);
  });

  it("releases the lock through termux-wake-unlock", () => {
    const prefix = fakePrefix({ "termux-wake-unlock": "exit 0" });
    expect(releaseWakeLock({ env: envFor(prefix) }).ok).toBe(true);
  });

  it("reports failure instead of throwing when termux-api is absent", () => {
    // The Gateway still runs in the foreground; it just cannot survive Doze.
    const result = acquireWakeLock({ env: { PATH: "/nonexistent-dir" } });
    expect(result).toMatchObject({ ok: false, reason: "not-installed" });
  });
});
