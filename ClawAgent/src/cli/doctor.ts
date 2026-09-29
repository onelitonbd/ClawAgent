// `clawagent doctor` — the first surface of the capability ledger.
//
// This is the command a user runs on a phone when something does not work, so it
// optimises for "what is wrong and what do I type next", not for completeness.
// Every check is non-destructive: `doctor` creates the state directory (which
// any run would create anyway) and writes nothing else.
//
// Remediation text is host-specific. Under Termux it says `pkg install ...`;
// elsewhere it says what a normal machine would need. The two must never be
// merged, because the Termux instructions are the only ones that can work on
// Android and the desktop instructions cannot.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildLedger,
  capability,
  renderLedger,
  renderLedgerLegend,
  renderLedgerSummary,
  type Capability,
  type CapabilityId,
  type CapabilityLedger,
  type CapabilityStatus,
} from "../capability/ledger.ts";
import {
  describeClawAgentPaths,
  resolveDefaultClawAgentPaths,
  type ClawAgentPaths,
} from "../config/paths.ts";
import { readDeviceFacts, type DeviceFacts } from "../platform/facts.ts";
import { formatNodeRemediationSummary } from "../platform/node-requirement.ts";
import type { TermuxApiCommand } from "../platform/termux-api.ts";

/** Below this much free space the host still works but should not be trusted with media. */
export const FREE_STORAGE_WARN_BYTES = 512 * 1024 * 1024;
/** Below this the host cannot be expected to open a SQLite database. */
export const FREE_STORAGE_FAIL_BYTES = 96 * 1024 * 1024;
/** Below this much device RAM, concurrency must be conservative. */
export const LOW_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

/** Result of probing whether a directory can actually be written. */
export type WritabilityProbe = {
  ok: boolean;
  /** Why the probe failed, when it did. */
  reason?: string;
};

/**
 * Verifies a directory is writable by creating it and writing a probe file.
 *
 * A real write is required rather than an `access(W_OK)` check: on Android the
 * permission bits frequently say writable while the write fails (scoped storage,
 * a read-only `/data/data` view, or a `com.termux` home reached from another
 * app's context). Only attempting the write detects that.
 */
export function probeWritableDirectory(directory: string): WritabilityProbe {
  try {
    mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.clawagent-write-probe-${process.pid}`);
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe, { force: true });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Formats a byte count the way a phone user reads it. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return "unknown";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/** Termux instructions for the `termux-api` package plus its Android app. */
function termuxApiRemediation(): string[] {
  return [
    "pkg install termux-api",
    "Install the Termux:API app from F-Droid (same source as Termux itself; the Play Store build is stale and will not talk to it)",
    "Grant the permissions the feature needs (notifications, battery) when Android asks",
  ];
}

/** Assembles the capability ledger from collected facts. */
export function buildDoctorLedger(params: {
  facts: DeviceFacts;
  paths: ClawAgentPaths | undefined;
  writable: WritabilityProbe;
}): CapabilityLedger {
  const { facts, paths, writable } = params;
  const capabilities: Capability[] = [];
  const termux = facts.termux;

  // --- Node runtime: the one hard gate -----------------------------------
  capabilities.push(
    facts.runtime.supported
      ? capability("node.runtime", "available", `v${facts.runtime.version} (requires ${facts.runtime.required})`, {
          required: true,
        })
      : capability("node.runtime", "unavailable", `v${facts.runtime.version} is below the floor`, {
          required: true,
          // One line here; the full explanation is printed in the report footer.
          remediation: [
            formatNodeRemediationSummary({
              version: facts.runtime.version,
              termux: termux.isTermux,
            }),
          ],
        }),
  );

  capabilities.push(
    facts.nodeSqliteAvailable
      ? capability("node.sqlite", "available", "DatabaseSync present", { required: true })
      : capability("node.sqlite", "unavailable", "node:sqlite is not available in this build", {
          required: true,
          remediation: termux.isTermux
            ? [
                "Termux's nodejs package normally includes node:sqlite; reinstall it:",
                "  pkg update && pkg reinstall nodejs-lts",
              ]
            : ["Use a Node build that includes node:sqlite (the official binaries do)."],
        }),
  );

  // --- Host ---------------------------------------------------------------
  if (termux.isTermux) {
    capabilities.push(
      capability(
        "host.termux",
        "available",
        `Termux detected (${termux.signal})${termux.prefix ? `, PREFIX=${termux.prefix}` : ""}`,
      ),
    );
  } else {
    capabilities.push(
      capability(
        "host.termux",
        "unavailable",
        facts.platform === "android"
          ? "Android platform without Termux: no pkg, no termux-api"
          : `not Termux (platform=${facts.platform}); Android integrations disabled`,
        {
          remediation:
            facts.platform === "android"
              ? [
                  "Install Termux from F-Droid or GitHub releases (not the Play Store build)",
                  "pkg install nodejs-lts",
                ]
              : [],
        },
      ),
    );
  }

  // --- State --------------------------------------------------------------
  if (!paths) {
    capabilities.push(
      capability("state.home", "unavailable", "no home directory could be resolved", {
        required: true,
        remediation: termux.isTermux
          ? [
              "Termux derives home from $PREFIX, but neither HOME nor PREFIX is usable here.",
              "Run inside a Termux session, or set CLAWAGENT_HOME to a writable directory.",
            ]
          : ["Set CLAWAGENT_HOME to a writable directory."],
      }),
    );
  } else {
    capabilities.push(capability("state.home", "available", paths.home, { required: true }));
    capabilities.push(
      writable.ok
        ? capability("state.writable", "available", `${paths.stateDir} is writable`, { required: true })
        : capability(
            "state.writable",
            "unavailable",
            `cannot write to ${paths.stateDir}: ${writable.reason ?? "unknown error"}`,
            {
              required: true,
              remediation: termux.isTermux
                ? [
                    "Check the directory is not on shared storage (Android blocks writes there):",
                    "  echo $CLAWAGENT_HOME",
                    "Leave it unset to use the Termux home, which is writable.",
                  ]
                : ["Set CLAWAGENT_HOME to a directory this user may write to."],
            },
          ),
    );
  }

  // --- termux-api ---------------------------------------------------------
  const commands = facts.termuxApi.commands;
  // Per-command rows deliberately carry no remediation: they all come from the
  // same `termux-api` package, so repeating the install steps on every row
  // buries the one thing the user needs to type. The aggregate row owns them.
  const apiCapability = (
    id: CapabilityId,
    command: TermuxApiCommand,
    purpose: string,
  ): Capability =>
    commands[command]
      ? capability(id, "available", `${command} found`)
      : capability(id, "unavailable", `${command} not installed (${purpose})`);

  capabilities.push(
    facts.termuxApi.installed
      ? capability(
          "termux-api.installed",
          "available",
          `${Object.keys(commands).length} of ${facts.termuxApi.missing.length + Object.keys(commands).length} commands found`,
        )
      : capability(
          "termux-api.installed",
          "unavailable",
          "no termux-api commands found",
          { remediation: termux.isTermux ? termuxApiRemediation() : [] },
        ),
  );
  capabilities.push(
    apiCapability(
      "termux-api.wake-lock",
      "termux-wake-lock",
      "without it Android suspends the Gateway when the screen turns off",
    ),
  );
  capabilities.push(apiCapability("termux-api.notification", "termux-notification", "user-visible alerts"));
  capabilities.push(apiCapability("termux-api.battery", "termux-battery-status", "battery-aware throttling"));
  capabilities.push(apiCapability("termux-api.clipboard", "termux-clipboard-set", "copy/paste integration"));

  // --- Battery ------------------------------------------------------------
  if (facts.battery.available) {
    const parts = [
      facts.battery.percentage === undefined ? undefined : `${facts.battery.percentage}%`,
      facts.battery.plugged === undefined ? undefined : `plugged=${facts.battery.plugged}`,
      facts.battery.health === undefined ? undefined : `health=${facts.battery.health}`,
      facts.battery.temperature === undefined ? undefined : `${facts.battery.temperature}C`,
    ].filter((part): part is string => part !== undefined);
    capabilities.push(capability("battery.reading", "available", parts.join(" ") || "readable"));
  } else {
    capabilities.push(
      capability("battery.reading", "unavailable", `no reading (${facts.battery.reason ?? "unknown"})`),
    );
  }

  // --- Storage ------------------------------------------------------------
  const availableBytes = facts.storage.availableBytes;
  if (availableBytes === null) {
    capabilities.push(
      capability("storage.free", "degraded", `could not measure (${facts.storage.reason ?? "unknown"})`),
    );
  } else {
    const status: CapabilityStatus =
      availableBytes < FREE_STORAGE_FAIL_BYTES
        ? "unavailable"
        : availableBytes < FREE_STORAGE_WARN_BYTES
          ? "degraded"
          : "available";
    capabilities.push(
      capability("storage.free", status, `${formatBytes(availableBytes)} free on ${facts.storage.path}`, {
        ...(status === "available"
          ? {}
          : {
              remediation: [
                "Free space by pruning transcripts and media:",
                "  rm -rf ~/.clawagent/media/inbound/*",
                "Sessions and logs live under the state directory shown above.",
              ],
            }),
      }),
    );
  }

  // --- Memory -------------------------------------------------------------
  const total = facts.resources.totalMemoryBytes;
  const lowMemory = total < LOW_MEMORY_BYTES && termux.isTermux;
  capabilities.push(
    capability(
      "resources.memory",
      lowMemory ? "degraded" : "available",
      termux.isTermux
        ? `${formatBytes(total)} device RAM, ${formatBytes(facts.resources.freeMemoryBytes)} free, ${facts.resources.availableParallelism} reported cores` +
            (lowMemory ? " — low; keep concurrency conservative" : "")
        : `${formatBytes(total)} total, ${formatBytes(facts.resources.freeMemoryBytes)} free`,
    ),
  );

  return buildLedger(capabilities);
}

/** Everything `doctor` produces, so the CLI and tests share one shape. */
export type DoctorReport = {
  facts: DeviceFacts;
  paths: ClawAgentPaths | undefined;
  ledger: CapabilityLedger;
  lines: string[];
  /** Process exit code: 0 when the host can start, 1 when it cannot. */
  exitCode: number;
};

/** Runs every check and renders the report. */
export function runDoctor(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform | string;
    arch?: string;
    /** Skip the battery spawn; used by tests and `--skip-battery`. */
    skipBattery?: boolean;
    storagePath?: string;
    /**
     * Pre-resolved state paths. The CLI passes these so that `--home` actually
     * changes what `doctor` reports; omitting them resolves from the environment.
     */
    paths?: ClawAgentPaths | undefined;
  } = {},
): DoctorReport {
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolveDefaultClawAgentPaths(env);
  const facts = readDeviceFacts({
    env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.arch === undefined ? {} : { arch: options.arch }),
    ...(options.skipBattery ? { skipBattery: true } : {}),
    // Measuring the volume the state directory lives on is the reading that
    // matters: a phone can have plenty of free space on shared storage and none
    // where the database has to go.
    storagePath: options.storagePath ?? paths?.stateDir ?? os.homedir(),
  });
  const writable = paths ? probeWritableDirectory(paths.stateDir) : { ok: false, reason: "no home" };
  const ledger = buildDoctorLedger({ facts, paths, writable });

  const lines: string[] = [];
  lines.push("ClawAgent doctor");
  lines.push(
    `node v${facts.runtime.version} on ${facts.platform}/${facts.arch} (kernel ${facts.kernelRelease})`,
  );
  lines.push(
    facts.termux.isTermux
      ? `host: Termux (signal=${facts.termux.signal})`
      : facts.platform === "android"
        ? "host: Android without Termux — pkg and termux-api are not available"
        : `host: ${facts.platform} — not a phone, so the termux-api rows below are expected to be unavailable`,
  );
  if (paths) {
    lines.push("");
    lines.push(...describeClawAgentPaths(paths));
  }
  lines.push("");
  lines.push(renderLedgerLegend());
  lines.push(...renderLedger(ledger));
  lines.push("");
  lines.push(...renderLedgerSummary(ledger));
  lines.push(ledger.startable ? "host can start" : "host cannot start; fix the items marked * above");
  if (facts.runtime.remediation) {
    lines.push("");
    lines.push("Node runtime — how to fix");
    lines.push(...facts.runtime.remediation.split("\n").map((line) => `  ${line}`.trimEnd()));
  }
  // Caveats are not fixes: they explain why a number that looks fine on a
  // server is not fine here. Keeping them out of the remediation column stops
  // `doctor` telling the user to act on something that is merely true.
  if (facts.termux.isTermux && facts.resources.caveats.length > 0) {
    lines.push("");
    lines.push("Reading these numbers on Android");
    for (const caveat of facts.resources.caveats) {
      lines.push(`  - ${caveat}`);
    }
  }

  return { facts, paths, ledger, lines, exitCode: ledger.startable ? 0 : 1 };
}

/** Serialises the report for `--json`, which the smoke test consumes. */
export function formatDoctorJson(report: DoctorReport): string {
  return JSON.stringify(
    {
      startable: report.ledger.startable,
      capabilities: report.ledger.capabilities,
      paths: report.paths ? { home: report.paths.home, state: report.paths.stateDir } : null,
      facts: {
        node: report.facts.runtime.version,
        platform: report.facts.platform,
        arch: report.facts.arch,
        termux: report.facts.termux,
        termuxApi: report.facts.termuxApi,
        storage: report.facts.storage,
        resources: report.facts.resources,
      },
    },
    null,
    2,
  );
}
