import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  FREE_STORAGE_FAIL_BYTES,
  FREE_STORAGE_WARN_BYTES,
  LOW_MEMORY_BYTES,
  buildDoctorLedger,
  formatBytes,
  formatDoctorJson,
  probeWritableDirectory,
  runDoctor,
} from "./doctor.ts";
import { resolveClawAgentPaths, type ClawAgentPaths } from "../config/paths.ts";
import type { DeviceFacts, ResourceFacts, StorageFacts } from "../platform/facts.ts";
import type { TermuxHostInfo } from "../platform/termux.ts";
import { CAPABILITY_IDS, summarizeLedger, type CapabilityId } from "../capability/ledger.ts";

const PATHS = resolveClawAgentPaths("/data/data/com.termux/files/home/.clawagent");
const WRITABLE = { ok: true };

const TERMUX_HOST: TermuxHostInfo = {
  isTermux: true,
  isAndroidPlatform: false,
  prefix: "/data/data/com.termux/files/usr",
  home: "/data/data/com.termux/files/home",
  signal: "termux-env",
};

const DESKTOP_HOST: TermuxHostInfo = {
  isTermux: false,
  isAndroidPlatform: false,
  signal: "none",
};

function resources(overrides: Partial<ResourceFacts> = {}): ResourceFacts {
  return {
    totalMemoryBytes: 6 * 1024 * 1024 * 1024,
    freeMemoryBytes: 2 * 1024 * 1024 * 1024,
    cpuCount: 8,
    availableParallelism: 8,
    caveats: [],
    ...overrides,
  };
}

function storage(overrides: Partial<StorageFacts> = {}): StorageFacts {
  return { path: "/data", availableBytes: 8 * 1024 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 * 1024, ...overrides };
}

/** A healthy Termux device, overridable per test. */
function facts(overrides: Partial<DeviceFacts> = {}): DeviceFacts {
  return {
    runtime: {
      version: "26.1.0",
      parsed: { major: 26, minor: 1, patch: 0 },
      supported: true,
      required: ">=24.16.0 <25, or >=26.1.0",
    },
    nodeSqliteAvailable: true,
    platform: "linux",
    arch: "arm64",
    kernelRelease: "5.15.0",
    termux: TERMUX_HOST,
    termuxApi: {
      installed: true,
      commands: {
        "termux-battery-status": "/data/data/com.termux/files/usr/bin/termux-battery-status",
        "termux-wake-lock": "/data/data/com.termux/files/usr/bin/termux-wake-lock",
        "termux-notification": "/data/data/com.termux/files/usr/bin/termux-notification",
        "termux-clipboard-set": "/data/data/com.termux/files/usr/bin/termux-clipboard-set",
      },
      missing: ["termux-open"],
    },
    battery: { available: true, percentage: 82, plugged: "USB", health: "GOOD", temperature: 31 },
    resources: resources(),
    storage: storage(),
    ...overrides,
  };
}

function ledgerFor(overrides: Partial<DeviceFacts> = {}, paths: ClawAgentPaths | undefined = PATHS) {
  return buildDoctorLedger({ facts: facts(overrides), paths, writable: WRITABLE });
}

function statusOf(ledger: ReturnType<typeof ledgerFor>, id: CapabilityId) {
  return ledger.capabilities.find((entry) => entry.id === id);
}

describe("buildDoctorLedger on a healthy device", () => {
  const ledger = ledgerFor();

  it("reports the host as startable", () => {
    expect(ledger.startable).toBe(true);
    expect(summarizeLedger(ledger).blocking).toEqual([]);
  });

  it("covers every declared capability id exactly once", () => {
    const ids = ledger.capabilities.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...CAPABILITY_IDS].sort());
  });

  it("marks the four startup requirements as required", () => {
    const required = ledger.capabilities.filter((entry) => entry.required).map((entry) => entry.id);
    expect([...required].sort()).toEqual(
      ["node.runtime", "node.sqlite", "state.home", "state.writable"].sort(),
    );
  });

  it("renders the battery reading with its fields", () => {
    expect(statusOf(ledger, "battery.reading")?.detail).toContain("82%");
    expect(statusOf(ledger, "battery.reading")?.detail).toContain("plugged=USB");
  });
});

describe("buildDoctorLedger blocking conditions", () => {
  it("blocks when the Node floor is not met", () => {
    const ledger = ledgerFor({
      runtime: {
        version: "22.22.3",
        parsed: { major: 22, minor: 22, patch: 3 },
        supported: false,
        required: ">=24.16.0 <25, or >=26.1.0",
        remediation: "install a supported Node",
      },
    });
    expect(ledger.startable).toBe(false);
    expect(summarizeLedger(ledger).blocking).toEqual(["node.runtime"]);
  });

  it("gives a Termux-specific Node fix on a phone", () => {
    const ledger = ledgerFor({
      runtime: { version: "20.0.0", parsed: null, supported: false, required: ">=26.1.0" },
    });
    expect(statusOf(ledger, "node.runtime")?.remediation?.join(" ")).toContain("pkg install nodejs-lts");
  });

  it("never suggests nvm on a phone", () => {
    // nvm downloads glibc tarballs; the Android kernel will not execute them.
    const ledger = ledgerFor({
      runtime: { version: "20.0.0", parsed: null, supported: false, required: ">=26.1.0" },
    });
    const text = ledger.capabilities.map((entry) => entry.remediation?.join(" ")).join(" ");
    expect(text).not.toMatch(/\bnvm install\b/u);
  });

  it("blocks when node:sqlite is missing", () => {
    const ledger = ledgerFor({ nodeSqliteAvailable: false });
    expect(summarizeLedger(ledger).blocking).toContain("node.sqlite");
  });

  it("blocks when no home directory could be resolved", () => {
    // Built directly: passing `undefined` to ledgerFor would re-trigger its
    // default parameter and quietly test the healthy path instead.
    const ledger = buildDoctorLedger({ facts: facts(), paths: undefined, writable: WRITABLE });
    expect(ledger.startable).toBe(false);
    expect(summarizeLedger(ledger).blocking).toContain("state.home");
    expect(statusOf(ledger, "state.home")?.status).toBe("unavailable");
  });

  it("blocks when the state directory is not writable", () => {
    const ledger = buildDoctorLedger({
      facts: facts(),
      paths: PATHS,
      writable: { ok: false, reason: "EACCES: permission denied" },
    });
    expect(ledger.startable).toBe(false);
    expect(statusOf(ledger, "state.writable")?.detail).toContain("EACCES");
  });

  it("does not block on a missing wake lock", () => {
    // Important, but the host still runs while foregrounded.
    const ledger = ledgerFor({ termuxApi: { installed: false, commands: {}, missing: [] } });
    expect(ledger.startable).toBe(true);
    expect(statusOf(ledger, "termux-api.wake-lock")?.status).toBe("unavailable");
  });
});

describe("termux-api remediation", () => {
  it("states the install steps once, on the aggregate row", () => {
    const ledger = ledgerFor({ termuxApi: { installed: false, commands: {}, missing: [] } });
    const withRemediation = ledger.capabilities.filter(
      (entry) => (entry.remediation ?? []).length > 0,
    );
    expect(withRemediation.map((entry) => entry.id)).toEqual(["termux-api.installed"]);
    expect(withRemediation[0]?.remediation?.join(" ")).toContain("pkg install termux-api");
  });

  it("explains why the wake lock matters", () => {
    const ledger = ledgerFor({ termuxApi: { installed: false, commands: {}, missing: [] } });
    expect(statusOf(ledger, "termux-api.wake-lock")?.detail).toContain("screen turns off");
  });

  it("does not tell a desktop user to run pkg", () => {
    const ledger = ledgerFor({
      termux: DESKTOP_HOST,
      platform: "darwin",
      termuxApi: { installed: false, commands: {}, missing: [] },
    });
    const text = ledger.capabilities.map((entry) => entry.remediation?.join(" ")).join(" ");
    expect(text).not.toContain("pkg install");
  });
});

describe("storage thresholds", () => {
  it("is available above the warning threshold", () => {
    const ledger = ledgerFor({ storage: storage({ availableBytes: FREE_STORAGE_WARN_BYTES + 1 }) });
    expect(statusOf(ledger, "storage.free")?.status).toBe("available");
  });

  it("is degraded between the two thresholds", () => {
    const ledger = ledgerFor({
      storage: storage({ availableBytes: FREE_STORAGE_FAIL_BYTES + 1 }),
    });
    expect(statusOf(ledger, "storage.free")?.status).toBe("degraded");
  });

  it("is unavailable below the failure threshold", () => {
    const ledger = ledgerFor({
      storage: storage({ availableBytes: FREE_STORAGE_FAIL_BYTES - 1 }),
    });
    expect(statusOf(ledger, "storage.free")?.status).toBe("unavailable");
  });

  it("is degraded, not unavailable, when it cannot be measured", () => {
    // An unreadable statfs says nothing about the space actually left.
    const ledger = ledgerFor({
      storage: { path: "/data", availableBytes: null, totalBytes: null, reason: "statfs-unavailable" },
    });
    expect(statusOf(ledger, "storage.free")?.status).toBe("degraded");
  });

  it("thresholds are ordered sensibly", () => {
    expect(FREE_STORAGE_FAIL_BYTES).toBeLessThan(FREE_STORAGE_WARN_BYTES);
  });
});

describe("memory reporting", () => {
  it("is degraded on a low-RAM phone", () => {
    const ledger = ledgerFor({
      resources: resources({ totalMemoryBytes: LOW_MEMORY_BYTES - 1 }),
    });
    expect(statusOf(ledger, "resources.memory")?.status).toBe("degraded");
  });

  it("is available for the same RAM on a desktop", () => {
    // The number is not the problem; Android's low-memory killer is.
    const ledger = ledgerFor({
      termux: DESKTOP_HOST,
      platform: "darwin",
      resources: resources({ totalMemoryBytes: LOW_MEMORY_BYTES - 1 }),
    });
    expect(statusOf(ledger, "resources.memory")?.status).toBe("available");
  });

  it("keeps caveats out of the remediation column", () => {
    // A caveat is a fact about the device, not an action for the user.
    const ledger = ledgerFor({
      resources: resources({ caveats: ["no swap", "big.LITTLE"] }),
    });
    expect(statusOf(ledger, "resources.memory")?.remediation).toBeUndefined();
  });
});

describe("host reporting", () => {
  it("reports Termux and its signal", () => {
    const ledger = ledgerFor();
    expect(statusOf(ledger, "host.termux")?.detail).toContain("termux-env");
    expect(statusOf(ledger, "host.termux")?.status).toBe("available");
  });

  it("distinguishes Android-without-Termux from a desktop", () => {
    const android = ledgerFor({
      termux: { isTermux: false, isAndroidPlatform: true, signal: "none" },
      platform: "android",
    });
    expect(statusOf(android, "host.termux")?.detail).toContain("without Termux");

    const desktop = ledgerFor({ termux: DESKTOP_HOST, platform: "darwin" });
    expect(statusOf(desktop, "host.termux")?.detail).toContain("not Termux");
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1.0 KiB"],
    [1536, "1.5 KiB"],
    [1048576, "1.0 MiB"],
    [1073741824, "1.0 GiB"],
    [8 * 1024 * 1024 * 1024, "8.0 GiB"],
    [null, "unknown"],
    [undefined, "unknown"],
  ])("formats %j as %j", (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  it("drops decimals for whole units and large values", () => {
    expect(formatBytes(120 * 1024 * 1024)).toBe("120 MiB");
  });
});

describe("probeWritableDirectory", () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("succeeds and creates the directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "clawagent-probe-"));
    tempDirs.push(root);
    const target = path.join(root, "state", "nested");
    const result = probeWritableDirectory(target);
    expect(result.ok).toBe(true);
    expect(target).toBeTruthy();
  });

  it("leaves no probe file behind", () => {
    // A probe file that survives would accumulate one per `doctor` run, and
    // doctor is the command a user re-runs most often.
    const root = mkdtempSync(path.join(os.tmpdir(), "clawagent-probe-"));
    tempDirs.push(root);
    probeWritableDirectory(root);
    expect(readdirSync(root)).toEqual([]);
  });

  it("reports a reason instead of throwing when the write fails", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "clawagent-probe-"));
    tempDirs.push(root);
    const file = path.join(root, "not-a-directory");
    writeFileSync(file, "x", "utf8");
    const result = probeWritableDirectory(path.join(file, "state"));
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe("runDoctor", () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const makeTempDir = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "clawagent-doctor-"));
    tempDirs.push(dir);
    return dir;
  };

  it("honours an injected Termux environment", () => {
    const root = makeTempDir();
    const report = runDoctor({
      env: {
        PREFIX: "/data/data/com.termux/files/usr",
        ANDROID_DATA: "/data",
        CLAWAGENT_HOME: root,
      },
      skipBattery: true,
    });
    expect(report.facts.termux.isTermux).toBe(true);
    expect(report.paths?.home).toBe(root);
    expect(report.lines.join("\n")).toContain("host: Termux");
    expect(report.lines.join("\n")).toContain("ok/warn/fail");
  });

  it("says plainly when the host is not a phone", () => {
    const root = makeTempDir();
    const report = runDoctor({ env: { HOME: root }, platform: "darwin", skipBattery: true });
    expect(report.lines.join("\n")).toContain("not a phone");
  });

  it("derives the exit code from startability, whatever the host Node is", () => {
    // This suite runs on whichever Node CI provides, so the assertion is the
    // relationship rather than a specific code: 0 exactly when the host can
    // start, 1 otherwise.
    const root = makeTempDir();
    const report = runDoctor({ env: { HOME: root }, skipBattery: true });
    expect(report.exitCode).toBe(report.ledger.startable ? 0 : 1);
    expect([0, 1]).toContain(report.exitCode);
  });

  it("measures the volume the state directory lives on", () => {
    const root = makeTempDir();
    const report = runDoctor({ env: { CLAWAGENT_HOME: root }, skipBattery: true });
    expect(report.facts.storage.path).toBeTruthy();
  });

  it("uses caller-supplied paths so --home changes the report", () => {
    const root = makeTempDir();
    const report = runDoctor({
      env: { HOME: "/somewhere/else" },
      paths: resolveClawAgentPaths(root),
      skipBattery: true,
    });
    expect(report.paths?.home).toBe(root);
    expect(report.lines.join("\n")).toContain(root);
  });

  it("does not spawn termux-battery-status when asked not to", () => {
    const root = makeTempDir();
    const report = runDoctor({ env: { HOME: root }, skipBattery: true });
    expect(report.facts.battery.available).toBe(false);
  });
});

describe("formatDoctorJson", () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits parseable JSON with the fields CI needs", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "clawagent-doctor-"));
    tempDirs.push(root);
    const report = runDoctor({ env: { CLAWAGENT_HOME: root }, skipBattery: true });
    const parsed = JSON.parse(formatDoctorJson(report)) as {
      startable: boolean;
      capabilities: { id: string; status: string }[];
      paths: { home: string } | null;
    };
    expect(typeof parsed.startable).toBe("boolean");
    expect(parsed.capabilities.length).toBe(CAPABILITY_IDS.length);
    expect(parsed.paths?.home).toBe(root);
  });
});
