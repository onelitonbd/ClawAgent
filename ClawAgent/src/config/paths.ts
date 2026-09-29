// Home and state path resolution for ClawAgent.
//
// This module deliberately reimplements the OS home-dir rules that
// `@openclaw/normalization-core/home-dir` implements, rather than importing it.
// The reason is on-device execution: every workspace package resolves its
// imports with `.js` specifiers (normalization-core alone has 48), which Node's
// type-stripping loader cannot resolve against `.ts` sources. ClawAgent runs
// from source on the phone, so a runtime dependency on any workspace package
// would make it unstartable. M0 therefore depends on nothing.
//
// That is a real cost: home-dir rules can drift between the two. The drift is
// closed by `src/config/paths-contract.test.ts`, which asserts byte-for-byte
// agreement between `resolveOsHomeDir` here and
// `resolveOsHomeDir` in normalization-core across desktop, Termux, Windows, and
// broken-env cases. Change one and the contract test fails until the other
// matches. This is the same anti-drift pattern used for `src/platform/termux.ts`.
//
// Once a build/bundle step exists (M1+), ClawAgent switches to the real package
// and this duplication is deleted.

import os from "node:os";
import path from "node:path";

/**
 * Drops values that are not usable as a home directory.
 *
 * `HOME` arrives unset, empty, whitespace-only, or as the literal strings
 * `"undefined"` / `"null"` on Windows and from misconfigured launchers. On
 * Termux, Node's `os.homedir()` reads `HOME` and returns `$PREFIX/home` — which
 * does not exist — when `HOME` is missing, so this guard is the difference
 * between a working state directory and one written to a path that cannot be
 * created.
 */
export function normalizeHomeDirValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
}

function normalizeSafe(homedir: () => string): string | undefined {
  try {
    return normalizeHomeDirValue(homedir());
  } catch {
    return undefined;
  }
}

/**
 * Recovers the Termux home from `$PREFIX`.
 *
 * Termux's real home is `/data/data/com.termux/files/home`, a sibling of
 * `$PREFIX`. This only fires when both `$PREFIX` and `$ANDROID_DATA` are set, so
 * a stray `PREFIX` on a desktop shell cannot relocate the home directory.
 */
function resolveTermuxHome(env: NodeJS.ProcessEnv): string | undefined {
  const prefix = normalizeHomeDirValue(env.PREFIX);
  if (!prefix || !normalizeHomeDirValue(env.ANDROID_DATA)) {
    return undefined;
  }
  if (!/(?:^|\/)com\.termux\/files\/usr\/?$/u.test(prefix.replace(/\\/gu, "/"))) {
    return undefined;
  }
  return path.resolve(prefix, "..", "home");
}

function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  return (
    normalizeHomeDirValue(env.HOME) ??
    normalizeHomeDirValue(env.USERPROFILE) ??
    resolveTermuxHome(env) ??
    normalizeSafe(homedir)
  );
}

/** Absolute OS home directory, or `undefined` when it cannot be determined. */
export function resolveOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawOsHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

/**
 * Home directory ClawAgent should use, honouring `CLAWAGENT_HOME`.
 *
 * `CLAWAGENT_HOME` overrides the OS home — the mobile equivalent of
 * `OPENCLAW_HOME`, kept under ClawAgent's own name so a device can run both
 * hosts without their state colliding. A leading `~` is expanded against the OS
 * home and dropped when that cannot be resolved; an unresolved tilde must never
 * become a literal `~` directory.
 */
export function resolveClawAgentHome(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const explicit = normalizeHomeDirValue(env.CLAWAGENT_HOME);
  if (!explicit) {
    const osHome = resolveOsHomeDir(env, homedir);
    return osHome ? path.resolve(osHome, DEFAULT_STATE_DIR_NAME) : undefined;
  }
  if (explicit === "~" || explicit.startsWith("~/") || explicit.startsWith("~\\")) {
    const osHome = resolveRawOsHomeDir(env, homedir);
    if (!osHome) {
      return undefined;
    }
    return path.resolve(explicit.replace(/^~(?=$|[\\/])/, () => osHome));
  }
  return path.resolve(explicit);
}

/** Directory name under the OS home that holds all ClawAgent state. */
export const DEFAULT_STATE_DIR_NAME = ".clawagent";

/** Config file name inside the ClawAgent home. */
export const CONFIG_FILE_NAME = "clawagent.json";

/** The full on-disk layout, resolved once at startup. */
export type ClawAgentPaths = {
  /** State root; everything below is relative to it. */
  home: string;
  configFile: string;
  /** SQLite databases: sessions, memory index, cron state. */
  stateDir: string;
  sessionDatabase: string;
  /** Per-agent trees, mirroring the desktop `agents/<id>/` layout. */
  agentsDir: string;
  logsDir: string;
  credentialsDir: string;
  mediaDir: string;
  mediaInboundDir: string;
  mediaOutboundDir: string;
  skillsDir: string;
  cronDir: string;
  canvasDir: string;
  updatesDir: string;
  /** Lock file guarding a single Gateway per state directory. */
  lockFile: string;
};

/** Resolves the full layout from a ClawAgent home directory. */
export function resolveClawAgentPaths(home: string): ClawAgentPaths {
  const agentsDir = path.join(home, "agents");
  const mediaDir = path.join(home, "media");
  return {
    home,
    configFile: path.join(home, CONFIG_FILE_NAME),
    stateDir: path.join(home, "state"),
    sessionDatabase: path.join(home, "state", "clawagent.sqlite"),
    agentsDir,
    logsDir: path.join(home, "logs"),
    credentialsDir: path.join(home, "credentials"),
    mediaDir,
    mediaInboundDir: path.join(mediaDir, "inbound"),
    mediaOutboundDir: path.join(mediaDir, "outbound"),
    skillsDir: path.join(home, "skills"),
    cronDir: path.join(home, "cron"),
    canvasDir: path.join(home, "canvas"),
    updatesDir: path.join(home, "updates"),
    lockFile: path.join(home, "gateway.lock"),
  };
}

/** Resolves the layout for this machine, or `undefined` when home is unknown. */
export function resolveDefaultClawAgentPaths(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): ClawAgentPaths | undefined {
  const home = resolveClawAgentHome(env, homedir);
  return home ? resolveClawAgentPaths(home) : undefined;
}

/**
 * Characters permitted in an agent id.
 *
 * This mirrors `@openclaw/normalization-core/agent-id` exactly — same character
 * class, same length bound, same lowercase canonical form — because agent ids
 * are directory names under `agents/` and the desktop host writes the same
 * layout. Two hosts that disagree about an id would produce two directories for
 * one agent. `paths-contract.test.ts` pins the agreement.
 *
 * Dots are deliberately excluded (the desktop rule excludes them too), which is
 * also what makes `..` and hidden directories unreachable from an id.
 */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const INVALID_AGENT_ID_CHARS_RE = /[^a-z0-9_-]+/giu;

/** True when a value is already a canonical agent-id input. */
export function isValidAgentId(value: string | undefined | null): boolean {
  const trimmed = (value ?? "").trim();
  return Boolean(trimmed) && AGENT_ID_PATTERN.test(trimmed);
}

/**
 * Canonicalizes an agent id for filesystem use, or returns `undefined`.
 *
 * Unlike the desktop helper this does not fall back to `"main"`: a silent
 * default would let a misrouted message land in the main agent's session
 * history, and on a phone the state directory is small enough that such a
 * mistake is invisible until it is expensive. Callers decide the fallback.
 */
export function normalizeAgentId(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (AGENT_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const repaired = trimmed
    .replace(INVALID_AGENT_ID_CHARS_RE, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "")
    .slice(0, 64);
  return repaired ? repaired : undefined;
}

/** Directory holding one agent's sessions. Returns `undefined` for a bad id. */
export function agentDir(paths: ClawAgentPaths, agentId: string): string | undefined {
  const normalized = normalizeAgentId(agentId);
  return normalized ? path.join(paths.agentsDir, normalized) : undefined;
}

/** Directory holding one agent's JSONL session logs. */
export function agentSessionsDir(paths: ClawAgentPaths, agentId: string): string | undefined {
  const dir = agentDir(paths, agentId);
  return dir ? path.join(dir, "sessions") : undefined;
}

/** Absolute path to a log file under `logs/`. */
export function logFilePath(paths: ClawAgentPaths, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/gu, "_");
  return path.join(paths.logsDir, `${safe}.log`);
}

/** Human-readable layout lines for `doctor`. */
export function describeClawAgentPaths(paths: ClawAgentPaths): string[] {
  return [
    `home          ${paths.home}`,
    `config        ${paths.configFile}`,
    `state         ${paths.stateDir}`,
    `sessions db   ${paths.sessionDatabase}`,
    `agents        ${paths.agentsDir}`,
    `logs          ${paths.logsDir}`,
    `credentials   ${paths.credentialsDir}`,
    `media         ${paths.mediaDir}`,
    `skills        ${paths.skillsDir}`,
    `cron          ${paths.cronDir}`,
  ];
}
