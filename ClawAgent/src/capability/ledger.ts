// The capability ledger.
//
// A capability is something the host would like to do (run agents, persist
// sessions, hold a wake lock, send a notification) together with the honest
// answer to "can it, on this device, right now". The ledger is the single place
// those answers live.
//
// Why this exists at M0 rather than later: a phone is not a server. Whether
// Termux:API is installed, whether the wake lock can be held, whether SQLite is
// compiled in, how much free space is left — all of these change what the agent
// may promise the user, and none of them are knowable at build time. Every
// later milestone registers its capabilities here instead of inventing its own
// detection, and `doctor` renders the result. A feature that degrades must be
// able to say why.
//
// This module is pure: it takes facts in and produces ledger entries out. All
// I/O happens in the caller (`src/cli/doctor.ts`), which keeps every ledger
// rule testable without a device.

/** Stable identifiers for capabilities the host knows about. */
export const CAPABILITY_IDS = [
  "node.runtime",
  "node.sqlite",
  "host.termux",
  "state.home",
  "state.writable",
  "termux-api.installed",
  "termux-api.wake-lock",
  "termux-api.notification",
  "termux-api.battery",
  "termux-api.clipboard",
  "battery.reading",
  "storage.free",
  "resources.memory",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/**
 * Availability of a capability.
 *
 * `degraded` is the important one. Most mobile failures are not binary: the
 * host still works, but with a smaller promise. Reporting `unavailable` for a
 * degraded capability would tell the user to fix something that is fine, and
 * reporting `available` would hide a real limitation.
 */
export type CapabilityStatus = "available" | "degraded" | "unavailable";

export type Capability = {
  id: CapabilityId;
  /** Short human label, e.g. "Node runtime". */
  label: string;
  status: CapabilityStatus;
  /** One line describing the observed state. */
  detail: string;
  /**
   * Concrete steps to improve the status, in order. On Termux these are `pkg`
   * commands and Android app installs; never nvm, never a glibc toolchain.
   */
  remediation?: string[];
  /** True when the host cannot start at all without this capability. */
  required?: boolean;
};

export type CapabilityLedger = {
  capabilities: Capability[];
  /** True when every required capability is available. */
  startable: boolean;
};

export type LedgerSummary = {
  total: number;
  available: number;
  degraded: number;
  unavailable: number;
  /** Required capabilities that are not available. */
  blocking: CapabilityId[];
};

const LABELS: Record<CapabilityId, string> = {
  "node.runtime": "Node runtime",
  "node.sqlite": "node:sqlite",
  "host.termux": "Termux host",
  "state.home": "Home directory",
  "state.writable": "Writable state",
  "termux-api.installed": "termux-api",
  "termux-api.wake-lock": "Wake lock",
  "termux-api.notification": "Notifications",
  "termux-api.battery": "Battery status",
  "termux-api.clipboard": "Clipboard",
  "battery.reading": "Battery reading",
  "storage.free": "Free storage",
  "resources.memory": "Memory",
};

/** Looks up the canonical label for a capability id. */
export function capabilityLabel(id: CapabilityId): string {
  return LABELS[id];
}

/** Builds a capability entry, filling in the canonical label. */
export function capability(
  id: CapabilityId,
  status: CapabilityStatus,
  detail: string,
  options: { remediation?: string[]; required?: boolean } = {},
): Capability {
  return {
    id,
    label: LABELS[id],
    status,
    detail,
    ...(options.remediation ? { remediation: options.remediation } : {}),
    ...(options.required ? { required: true } : {}),
  };
}

/** Assembles a ledger and decides whether the host can start. */
export function buildLedger(capabilities: readonly Capability[]): CapabilityLedger {
  const blocking = capabilities
    .filter((entry) => entry.required && entry.status !== "available")
    .map((entry) => entry.id);
  return { capabilities: [...capabilities], startable: blocking.length === 0 };
}

/** Counts statuses and lists what blocks startup. */
export function summarizeLedger(ledger: CapabilityLedger): LedgerSummary {
  const capabilities = ledger.capabilities;
  return {
    total: capabilities.length,
    available: capabilities.filter((entry) => entry.status === "available").length,
    degraded: capabilities.filter((entry) => entry.status === "degraded").length,
    unavailable: capabilities.filter((entry) => entry.status === "unavailable").length,
    blocking: capabilities
      .filter((entry) => entry.required && entry.status !== "available")
      .map((entry) => entry.id),
  };
}

const STATUS_MARK: Record<CapabilityStatus, string> = {
  available: "ok",
  degraded: "warn",
  unavailable: "fail",
};

/** Column width reserved for the status mark. */
export const STATUS_MARK_WIDTH = 4;

/** Legend explaining the rendered columns. */
export function renderLedgerLegend(): string {
  return "ok/warn/fail, * = required to start";
}

/**
 * Renders the ledger as column-aligned plain text.
 *
 * The status mark is padded to a fixed width because the words are not the same
 * length ("ok" is 2 characters, "warn" and "fail" are 4). Without padding the
 * required-marker and label columns drift by two characters on every healthy
 * row, which is most of the table.
 */
export function renderLedger(ledger: CapabilityLedger): string[] {
  const lines: string[] = [];
  const width = ledger.capabilities.reduce(
    (widest, entry) => Math.max(widest, entry.label.length),
    0,
  );
  for (const entry of ledger.capabilities) {
    const mark = STATUS_MARK[entry.status].padEnd(STATUS_MARK_WIDTH);
    const required = entry.required ? "*" : " ";
    lines.push(`${mark}${required} ${entry.label.padEnd(width)}  ${entry.detail}`);
    for (const step of entry.remediation ?? []) {
      lines.push(`    -> ${step}`);
    }
  }
  return lines;
}

/** Renders the summary footer, including blocking reasons. */
export function renderLedgerSummary(ledger: CapabilityLedger): string[] {
  const summary = summarizeLedger(ledger);
  const lines = [
    `${summary.available} available, ${summary.degraded} degraded, ${summary.unavailable} unavailable`,
  ];
  if (summary.blocking.length > 0) {
    lines.push(`cannot start: ${summary.blocking.join(", ")}`);
  }
  return lines;
}
