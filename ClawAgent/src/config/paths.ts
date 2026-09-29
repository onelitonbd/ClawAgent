// Home and state path resolution for ClawAgent.
//
// The OS home-dir rules and the agent-id rules are owned by
// `@openclaw/normalization-core` and imported from it, not reimplemented here.
// What this module owns is the part that is genuinely ClawAgent's: the
// `CLAWAGENT_HOME` override, the on-disk layout, and the filesystem-safety
// checks around turning an agent id into a directory name.
//
// Importing a workspace package from source works because of the resolve hook in
// `src/runtime/source-resolution.ts`. See `AGENTS.md` for why that hook exists,
// what it replaced, and what it costs.

import os from "node:os";
import path from "node:path";
import {
  isValidAgentId,
  normalizeAgentIdStrict,
} from "@openclaw/normalization-core/agent-id";
import {
  normalizeHomeDirValue,
  resolveOsHomeDir,
} from "@openclaw/normalization-core/home-dir";

// Imported under their public names and re-exported as the same bindings. A
// re-export rather than a wrapper function is what makes drift structurally
// impossible: `paths-contract.test.ts` asserts the exported value IS the upstream
// function, so a local lookalike with matching behaviour still fails the suite.
/**
 * Rules owned by normalization-core, re-exported unchanged.
 *
 * ClawAgent callers get one place to import path rules from, while the shared
 * package stays the single owner of the behaviour:
 *
 *   - `normalizeHomeDirValue` drops a `HOME` that arrives unset, blank, or as the
 *     literal strings `"undefined"`/`"null"`.
 *   - `resolveOsHomeDir` handles the Termux case where `HOME` is unset and Node's
 *     `os.homedir()` would return `$PREFIX/home` — a path that does not exist.
 *     `$PREFIX/..` is authoritative there.
 *   - `isValidAgentId` reports whether a value is already canonical.
 *
 * None of that is duplicated here, and it cannot be: these are the upstream
 * bindings themselves, which `paths-contract.test.ts` verifies by identity.
 */
export { isValidAgentId, normalizeHomeDirValue, resolveOsHomeDir };

/** Directory name under the OS home that holds all ClawAgent state. */
export const DEFAULT_STATE_DIR_NAME = ".clawagent";

/** Config file name inside the ClawAgent home. */
export const CONFIG_FILE_NAME = "clawagent.json";

/**
 * Home directory ClawAgent should use, honouring `CLAWAGENT_HOME`.
 *
 * The mobile equivalent of `OPENCLAW_HOME`, kept under ClawAgent's own name so a
 * device can run both hosts without their state colliding. A leading `~` is
 * expanded against the OS home and dropped when that cannot be resolved; an
 * unresolved tilde must never become a literal `~` directory.
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
    const osHome = resolveOsHomeDir(env, homedir);
    if (!osHome) {
      return undefined;
    }
    return path.resolve(explicit.replace(/^~(?=$|[\\/])/, () => osHome));
  }
  return path.resolve(explicit);
}

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
  const mediaDir = path.join(home, "media");
  return {
    home,
    configFile: path.join(home, CONFIG_FILE_NAME),
    stateDir: path.join(home, "state"),
    sessionDatabase: path.join(home, "state", "clawagent.sqlite"),
    agentsDir: path.join(home, "agents"),
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
 * Canonicalizes an agent id for filesystem use, or returns `undefined`.
 *
 * The character class, length bound, repair rules, and lowercase canonical form
 * all come from `@openclaw/normalization-core/agent-id`, so an agent id means
 * the same thing here as it does to the desktop host that writes the same
 * `agents/<id>/` layout. Dots are excluded there, which is also what makes `..`
 * and hidden directories unreachable from an id.
 *
 * Unlike the shared loose helper this does not fall back to `"main"`: a silent
 * default would let a misrouted message land in the main agent's session
 * history, and on a phone the state directory is small enough that such a
 * mistake stays invisible until it is expensive. Callers decide the fallback.
 */
export function normalizeAgentId(value: string | undefined | null): string | undefined {
  const result = normalizeAgentIdStrict(value);
  return result.ok ? result.value : undefined;
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

/**
 * Absolute path to a log file under `logs/`.
 *
 * Separators are what enable traversal, so they are replaced. A literal `..`
 * inside a filename is inert.
 */
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
