import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readDeviceFacts, readResourceFacts, readStorageFacts } from "./facts.ts";
import { TERMUX_API_COMMANDS } from "./termux-api.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clawagent-facts-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GIB = 1024 * 1024 * 1024;

describe("readResourceFacts", () => {
  it("reports the injected numbers unchanged", () => {
    const facts = readResourceFacts({
      isTermux: false,
      totalmem: () => 8 * GIB,
      freemem: () => 2 * GIB,
      cpus: () => [1, 2, 3, 4],
      availableParallelism: () => 4,
    });
    expect(facts).toMatchObject({
      totalMemoryBytes: 8 * GIB,
      freeMemoryBytes: 2 * GIB,
      cpuCount: 4,
      availableParallelism: 4,
    });
  });

  it("actually calls an injected parallelism reader", () => {
    // A regression guard: the injected reader used to be stored instead of
    // invoked, which silently reported a function as a core count.
    let calls = 0;
    const facts = readResourceFacts({
      isTermux: false,
      availableParallelism: () => {
        calls += 1;
        return 3;
      },
    });
    expect(calls).toBe(1);
    expect(facts.availableParallelism).toBe(3);
  });

  it("attaches no caveats off a phone", () => {
    expect(readResourceFacts({ isTermux: false }).caveats).toEqual([]);
  });

  it("explains why the numbers overstate the budget on Termux", () => {
    const caveats = readResourceFacts({ isTermux: true }).caveats;
    expect(caveats.join(" ")).toContain("low-memory killer");
    expect(caveats.join(" ")).toContain("big.LITTLE");
    expect(caveats.join(" ")).toContain("no swap");
  });

  it("derives cpuCount from the injected cpu list", () => {
    // `availableParallelism` itself falls back to the real `os` reader on modern
    // Node, so it is not asserted here; only the injected inputs are.
    const facts = readResourceFacts({
      isTermux: false,
      cpus: () => [1, 2, 3, 4, 5, 6],
      totalmem: () => GIB,
      freemem: () => GIB,
    });
    expect(facts.cpuCount).toBe(6);
    expect(facts.availableParallelism).toBeGreaterThan(0);
  });
});

describe("readStorageFacts", () => {
  it("measures a real directory", () => {
    const dir = tempDir();
    const facts = readStorageFacts(dir);
    expect(facts.path).toBe(dir);
    expect(facts.availableBytes).toBeGreaterThan(0);
    expect(facts.reason).toBeUndefined();
  });

  it("measures the nearest existing ancestor of a path that does not exist yet", () => {
    // On a first run the state directory has not been created; the volume is
    // still the thing worth reporting.
    const dir = tempDir();
    const missing = path.join(dir, "state", "nested", "deeper");
    const facts = readStorageFacts(missing);
    expect(facts.path).toBe(dir);
    expect(facts.availableBytes).toBeGreaterThan(0);
  });

  it("reports total space when the filesystem provides it", () => {
    const facts = readStorageFacts(tempDir());
    if (facts.totalBytes !== null) {
      expect(facts.totalBytes).toBeGreaterThanOrEqual(facts.availableBytes ?? 0);
    }
  });
});

describe("readDeviceFacts", () => {
  const env = { PATH: "/nonexistent-dir", HOME: tempDir() };

  it("detects a Termux host from the environment", () => {
    const facts = readDeviceFacts({
      env: { ...env, PREFIX: "/data/data/com.termux/files/usr", ANDROID_DATA: "/data" },
      platform: "linux",
      arch: "arm64",
      skipBattery: true,
    });
    expect(facts.termux.isTermux).toBe(true);
    expect(facts.platform).toBe("linux");
    expect(facts.arch).toBe("arm64");
    expect(facts.resources.caveats.length).toBeGreaterThan(0);
  });

  it("reports a non-Termux host without caveats", () => {
    const facts = readDeviceFacts({ env, platform: "darwin", skipBattery: true });
    expect(facts.termux.isTermux).toBe(false);
    expect(facts.resources.caveats).toEqual([]);
  });

  it("lists every termux-api command as missing when none are installed", () => {
    const facts = readDeviceFacts({ env, platform: "linux", skipBattery: true });
    expect(facts.termuxApi.installed).toBe(false);
    expect(facts.termuxApi.commands).toEqual({});
    expect([...facts.termuxApi.missing].sort()).toEqual([...TERMUX_API_COMMANDS].sort());
  });

  it("does not spawn anything when battery probing is skipped", () => {
    const facts = readDeviceFacts({ env, platform: "linux", skipBattery: true });
    expect(facts.battery).toEqual({ available: false, reason: "not-installed" });
  });

  it("includes the runtime verdict and the node:sqlite probe", () => {
    const facts = readDeviceFacts({ env, platform: "linux", skipBattery: true });
    expect(facts.runtime.version).toBeTruthy();
    expect(typeof facts.runtime.supported).toBe("boolean");
    expect(typeof facts.nodeSqliteAvailable).toBe("boolean");
    expect(facts.kernelRelease).toBeTruthy();
  });

  it("measures storage for the requested path", () => {
    const dir = tempDir();
    const facts = readDeviceFacts({ env, platform: "linux", skipBattery: true, storagePath: dir });
    expect(facts.storage.path).toBe(dir);
  });
});
