// Node runtime requirement for the mobile host.
//
// Reuses the repository's shared zero-dependency version contract rather than
// re-declaring a floor. `node-version.mjs` at the repository root is explicitly
// "shared by source and packaged entry points", is shipped in the published
// package `files`, and owns the floor for a real reason: older Node lines read
// SQLite TEXT lossily, which `node-sqlite.mjs` probes for. Moving that floor
// would be a correctness regression, so this module does not own it.
//
// What this module *does* own is remediation. The shared
// `formatUnsupportedNodeVersionMessage()` tells the operator to re-run
// `install.sh` or `nvm install 26`. Both are actively harmful on Android:
// Node.js publishes no Android binaries, `nvm` downloads glibc tarballs, and the
// Android kernel refuses to execute glibc ELF. Termux's own `pkg` is the only
// supported upgrade path, so the message is rebuilt here.

import {
  isSupportedOpenClawNodeVersion,
  parseNodeReleaseVersion,
  SUPPORTED_NODE_VERSIONS,
  type NodeReleaseVersion,
} from "../../../node-version.mjs";
import { isTermuxHost, type TermuxHostInfo } from "./termux.ts";

/** The authoritative floor, re-exported so callers never restate it. */
export const REQUIRED_NODE_VERSIONS = SUPPORTED_NODE_VERSIONS;

/** Everything a caller needs to decide whether this runtime may proceed. */
export type NodeRuntimeStatus = {
  /** Raw `process.versions.node`. */
  version: string;
  /** Parsed release components, or null when the string is not a release SemVer. */
  parsed: NodeReleaseVersion | null;
  /** Whether the runtime satisfies the shared OpenClaw floor. */
  supported: boolean;
  /** The floor, formatted for humans. */
  required: string;
  /** Host-appropriate fix, present only when `supported` is false. */
  remediation?: string;
};

/**
 * Reads the current runtime against the shared floor.
 *
 * `node:sqlite` correctness is what the floor protects, and the mobile host
 * depends on `node:sqlite` from the persistence milestone onward, so this is a
 * hard gate rather than a warning.
 */
export function readNodeRuntimeStatus(
  options: {
    version?: string;
    host?: TermuxHostInfo;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform | string;
  } = {},
): NodeRuntimeStatus {
  const version = options.version ?? process.versions.node;
  const supported = isSupportedOpenClawNodeVersion(version);
  return {
    version,
    parsed: parseNodeReleaseVersion(version),
    supported,
    required: REQUIRED_NODE_VERSIONS,
    ...(supported
      ? {}
      : {
          remediation: formatNodeRemediation({
            version,
            termux: options.host?.isTermux ?? isTermuxHost({ env: options.env, platform: options.platform }),
          }),
        }),
  };
}

/**
 * Formats the host-appropriate way to obtain a supported Node.
 *
 * Termux and non-Termux answers are deliberately different, because the
 * non-Termux answer cannot work on a phone.
 */
export function formatNodeRemediation(params: { version: string; termux: boolean }): string {
  if (!params.termux) {
    return (
      `Node ${params.version} is unsupported; OpenClaw requires ${REQUIRED_NODE_VERSIONS}. ` +
      "Re-run the installer, or install a supported Node with your system package manager."
    );
  }
  return [
    `Node ${params.version} is unsupported; OpenClaw requires ${REQUIRED_NODE_VERSIONS}.`,
    "",
    "On Termux, Node.js must come from Termux's own repository. Node.js publishes no",
    "Android binaries, and a Linux tarball is glibc-linked: the Android kernel refuses",
    "to execute it (Bionic libc, not glibc). Do not use nvm, n, fnm, or install.sh here.",
    "",
    "  pkg update && pkg upgrade -y",
    "  pkg install nodejs-lts",
    "  node -v",
    "",
    "If that still reports an unsupported version, Termux's packagers have not yet",
    "rebuilt against the required release line. Report it with `termux-info` output",
    "attached, or run the Gateway on another host and use this device as a client.",
  ].join("\n");
}

/**
 * One-line version of the remediation, for the capability ledger.
 *
 * The full message is several lines of explanation, which belongs in a report
 * footer rather than in a one-line-per-capability table. Both come from the same
 * host verdict so they cannot disagree about what to install.
 */
export function formatNodeRemediationSummary(params: { version: string; termux: boolean }): string {
  return params.termux
    ? "pkg update && pkg install nodejs-lts   (never nvm/n/fnm on Android: those fetch glibc builds)"
    : `install a supported Node: ${REQUIRED_NODE_VERSIONS}`;
}

/** True when this runtime can use the built-in `node:sqlite` module. */
export function hasNodeSqlite(): boolean {
  try {
    const sqlite = process.getBuiltinModule?.("node:sqlite") as
      | { DatabaseSync?: unknown }
      | undefined;
    return typeof sqlite?.DatabaseSync === "function";
  } catch {
    // A permission policy or an older runtime can make the probe itself throw.
    return false;
  }
}
