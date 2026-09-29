// Device facts for the mobile host.
//
// Zero-dependency and injection-friendly: every reader takes its inputs as
// parameters so `doctor` can be tested without a phone, and so nothing here can
// spawn or touch disk unexpectedly.
//
// Two Android-specific corrections the desktop host gets wrong are recorded
// here rather than silently applied:
//
//   1. `os.totalmem()` returns *device* RAM on Android, not a budget this
//      process may use. The desktop Gateway derives
//      `--max-old-space-size=4096` from it (`src/daemon/gateway-heap.ts`) and
//      Android's low-memory killer terminates the process long before V8 reaches
//      that heap. There is no swap and no meaningful cgroup quota.
//
//   2. `os.availableParallelism()` counts big.LITTLE cores as equals. The
//      desktop host derives 32 concurrent agent runs from an octa-core phone
//      (`src/config/agent-limits.ts`: `availableParallelism() * 4`) and 8 worker
//      isolates (`src/infra/worker-task-pool-core.ts`). Both are far past what a
//      phone sustains while also running the OS and a browser.
//
// Facts are reported raw, with the interpretation attached, so a resource
// decision made later is visible and reviewable instead of implicit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readTermuxBatteryStatus,
  probeTermuxApi,
  type TermuxApiCommand,
  type TermuxBatteryStatus,
} from "./termux-api.ts";
import { readTermuxHostInfo, type TermuxHostInfo } from "./termux.ts";
import { readNodeRuntimeStatus, hasNodeSqlite, type NodeRuntimeStatus } from "./node-requirement.ts";

/** Raw resource numbers, plus why they must not be taken at face value on Android. */
export type ResourceFacts = {
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  cpuCount: number;
  availableParallelism: number;
  /** Set when the numbers above are known to overstate the usable budget. */
  caveats: string[];
};

/** Free/total bytes for the volume containing a path. */
export type StorageFacts = {
  /** The path that was actually measured (the nearest existing ancestor). */
  path: string;
  availableBytes: number | null;
  totalBytes: number | null;
  /** Why no reading was available. */
  reason?: "statfs-unavailable" | "path-unreadable";
};

/** Everything `doctor` reports about this device. */
export type DeviceFacts = {
  runtime: NodeRuntimeStatus;
  nodeSqliteAvailable: boolean;
  platform: string;
  arch: string;
  kernelRelease: string;
  termux: TermuxHostInfo;
  termuxApi: {
    installed: boolean;
    commands: Partial<Record<TermuxApiCommand, string>>;
    missing: TermuxApiCommand[];
  };
  battery: TermuxBatteryStatus;
  resources: ResourceFacts;
  storage: StorageFacts;
};

/** Collects resource numbers and attaches the Android interpretation. */
export function readResourceFacts(
  options: {
    isTermux?: boolean;
    totalmem?: () => number;
    freemem?: () => number;
    cpus?: () => readonly unknown[];
    availableParallelism?: () => number;
  } = {},
): ResourceFacts {
  const isTermux = options.isTermux ?? readTermuxHostInfo().isTermux;
  const totalMemoryBytes = (options.totalmem ?? os.totalmem)();
  const freeMemoryBytes = (options.freemem ?? os.freemem)();
  const cpuCount = (options.cpus ?? os.cpus)().length;
  // Resolved as a function first, then called once: an injected reader has to
  // actually run, and `os.availableParallelism` is absent on older runtimes.
  const readAvailableParallelism =
    options.availableParallelism ??
    (typeof os.availableParallelism === "function" ? os.availableParallelism : () => cpuCount);
  const availableParallelism = readAvailableParallelism();
  const caveats: string[] = [];
  if (isTermux) {
    caveats.push(
      "totalmem is device RAM, not a usable budget; Android's low-memory killer " +
        "terminates the process well before V8 reaches a heap sized from it.",
    );
    caveats.push(
      "availableParallelism counts big.LITTLE cores as equals and overstates " +
        "sustained throughput; do not scale concurrency linearly from it.",
    );
    caveats.push("There is no swap. Memory pressure is fatal rather than slow.");
  }
  return { totalMemoryBytes, freeMemoryBytes, cpuCount, availableParallelism, caveats };
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Walks up from `targetPath` to the nearest existing ancestor.
 *
 * On a first run the state directory does not exist yet, and `statfs` on a
 * missing path throws. The volume is what we want to report, so measuring an
 * existing ancestor is correct, not a workaround.
 */
function nearestExistingPath(targetPath: string): string | undefined {
  let current = path.resolve(targetPath);
  // Bounded so a pathological path can never loop.
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      fs.statSync(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
  return undefined;
}

/** Reads free/total space for the volume containing `targetPath`. */
export function readStorageFacts(targetPath: string): StorageFacts {
  const statfsSync = (fs as Partial<typeof fs>).statfsSync;
  if (typeof statfsSync !== "function") {
    return { path: targetPath, availableBytes: null, totalBytes: null, reason: "statfs-unavailable" };
  }
  const measured = nearestExistingPath(targetPath);
  if (!measured) {
    return { path: targetPath, availableBytes: null, totalBytes: null, reason: "path-unreadable" };
  }
  try {
    const stats = statfsSync(measured) as {
      bsize?: number;
      bavail?: number;
      blocks?: number;
    };
    const blockSize = finiteNonNegative(stats.bsize);
    const availableBlocks = finiteNonNegative(stats.bavail);
    const totalBlocks = finiteNonNegative(stats.blocks);
    if (blockSize === null || availableBlocks === null) {
      return { path: targetPath, availableBytes: null, totalBytes: null, reason: "statfs-unavailable" };
    }
    return {
      path: measured,
      availableBytes: blockSize * availableBlocks,
      totalBytes: totalBlocks === null ? null : blockSize * totalBlocks,
    };
  } catch {
    return { path: targetPath, availableBytes: null, totalBytes: null, reason: "path-unreadable" };
  }
}

/** Collects the full device picture for `doctor`. */
export function readDeviceFacts(
  options: {
    storagePath?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform | string;
    arch?: string;
    skipBattery?: boolean;
  } = {},
): DeviceFacts {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const termux = readTermuxHostInfo({ env, platform });
  const commands = probeTermuxApi(env);
  const present = Object.entries(commands).filter(
    (entry): entry is [TermuxApiCommand, string] => entry[1] !== undefined,
  );
  const missing = (Object.keys(commands) as TermuxApiCommand[]).filter(
    (command) => commands[command] === undefined,
  );
  return {
    runtime: readNodeRuntimeStatus({ env, platform, host: termux }),
    nodeSqliteAvailable: hasNodeSqlite(),
    platform: String(platform),
    arch: options.arch ?? process.arch,
    kernelRelease: os.release(),
    termux,
    termuxApi: {
      installed: present.length > 0,
      commands: Object.fromEntries(present),
      missing,
    },
    battery: options.skipBattery
      ? { available: false, reason: "not-installed" }
      : readTermuxBatteryStatus({ env }),
    resources: readResourceFacts({ isTermux: termux.isTermux }),
    storage: readStorageFacts(options.storagePath ?? os.homedir()),
  };
}
