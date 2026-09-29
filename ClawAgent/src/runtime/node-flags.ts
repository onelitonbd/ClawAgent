// Process-flag respawn for the mobile host.
//
// ClawAgent runs the shared cores from TypeScript source. A few of those files
// use parameter properties (`constructor(private readonly policy: T)`), which
// Node's strip-only loader rejects outright — measured across the reuse list:
// `retry` (its only file), `ai` (1 file), `terminal-core` (3), `gateway-client`
// (8). Node's `--experimental-transform-types` performs a real transform and
// handles them.
//
// Flags cannot be added to the current process after startup, so the entry point
// re-executes itself once with the flags it needs. This follows the desktop
// host's own pattern in `src/entry.respawn.ts` — sentinel environment variable
// to prevent a respawn loop, `--disable-warning=ExperimentalWarning` to keep the
// terminal clean, and an escape hatch for operators.
//
// The plan builder is pure so the loop-prevention logic can be tested without
// spawning anything.

/** Enables a real TypeScript transform instead of type stripping only. */
export const TRANSFORM_TYPES_FLAG = "--experimental-transform-types";

/** Keeps experimental-feature noise off a phone terminal. */
export const SUPPRESS_WARNINGS_FLAG = "--disable-warning=ExperimentalWarning";

/** Set on the child so it never respawns again. */
export const FLAGS_READY_ENV = "CLAWAGENT_NODE_FLAGS_READY";

/** Operator escape hatch: run with whatever flags the caller supplied. */
export const NO_RESPAWN_ENV = "CLAWAGENT_NO_RESPAWN";

export type RespawnPlan = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Flags this respawn adds, for logging and diagnostics. */
  addedFlags: string[];
};

/** Truthy by the same convention the desktop host uses. */
export function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/** True when `execArgv` already carries `flag` (with or without a value). */
export function hasExecFlag(execArgv: readonly string[], flag: string): boolean {
  return execArgv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * True when this Node build recognises `flag`.
 *
 * Checked rather than assumed: passing an unrecognised flag makes Node refuse to
 * start at all, which would turn a working install into a broken one on a Node
 * release that renames or graduates the flag.
 */
export function isFlagSupported(
  flag: string,
  allowedFlags: ReadonlySet<string> | undefined = process.allowedNodeEnvironmentFlags,
): boolean {
  if (!allowedFlags) {
    return false;
  }
  // Node stores boolean flags without a value; tolerate either spelling.
  return allowedFlags.has(flag) || allowedFlags.has(flag.replace(/^--/u, ""));
}

/** True when the warning flag is already suppressed via argv or NODE_OPTIONS. */
export function hasWarningsSuppressed(
  params: { env?: NodeJS.ProcessEnv; execArgv?: readonly string[] } = {},
): boolean {
  const env = params.env ?? process.env;
  const execArgv = params.execArgv ?? process.execArgv;
  const nodeOptions = env.NODE_OPTIONS ?? "";
  if (nodeOptions.includes(SUPPRESS_WARNINGS_FLAG) || nodeOptions.includes("--no-warnings")) {
    return true;
  }
  return hasExecFlag(execArgv, SUPPRESS_WARNINGS_FLAG) || hasExecFlag(execArgv, "--no-warnings");
}

/**
 * Builds the respawn plan, or `null` when the current process is already fine.
 *
 * Returning `null` is the common case: after the first respawn the sentinel is
 * set, and every later invocation short-circuits here.
 */
export function buildNodeFlagRespawnPlan(
  params: {
    /** The script to re-run; normally the `bin/clawagent.mjs` path. */
    scriptPath: string;
    /**
     * Arguments after the script name.
     *
     * Passed in rather than derived from `process.argv`, because `argv[1]` may
     * be a symlink while `scriptPath` is the resolved target, and guessing which
     * slice of `argv` is user input from that pair is how a script path ends up
     * forwarded as a command name.
     */
    userArgs?: readonly string[];
    env?: NodeJS.ProcessEnv;
    execArgv?: readonly string[];
    execPath?: string;
    allowedFlags?: ReadonlySet<string>;
  },
): RespawnPlan | null {
  const env = params.env ?? process.env;
  const execArgv = params.execArgv ?? process.execArgv;
  const execPath = params.execPath ?? process.execPath;
  const userArgs = params.userArgs ?? process.argv.slice(2);
  const allowedFlags = params.allowedFlags ?? process.allowedNodeEnvironmentFlags;

  if (isTruthyEnvValue(env[NO_RESPAWN_ENV])) {
    return null;
  }
  if (isTruthyEnvValue(env[FLAGS_READY_ENV])) {
    return null;
  }

  const addedFlags: string[] = [];
  if (
    !hasExecFlag(execArgv, TRANSFORM_TYPES_FLAG) &&
    isFlagSupported(TRANSFORM_TYPES_FLAG, allowedFlags)
  ) {
    addedFlags.push(TRANSFORM_TYPES_FLAG);
  }
  if (!hasWarningsSuppressed({ env, execArgv })) {
    addedFlags.push(SUPPRESS_WARNINGS_FLAG);
  }
  if (addedFlags.length === 0) {
    return null;
  }

  const childEnv: NodeJS.ProcessEnv = { ...env, [FLAGS_READY_ENV]: "1" };
  return {
    command: execPath,
    args: [...addedFlags, ...execArgv, params.scriptPath, ...userArgs],
    env: childEnv,
    addedFlags,
  };
}
