// `termux-api` command resolution and execution.
//
// Zero-dependency by design: this module is how the mobile host reaches the
// Android platform (notifications, wake lock, battery, clipboard, TTS, share),
// and it must work before any workspace package resolves.
//
// Two rules the desktop host breaks and this one must not:
//   1. Never hardcode `/bin/*` or `/usr/bin/*`. Termux has no `/bin`; everything
//      lives under `$PREFIX`. Resolve through `$PREFIX/bin` and then `PATH`.
//   2. Never throw when a command is missing. `termux-api` is a separate
//      `pkg install` plus a separate Android app, so its absence is a normal,
//      reportable state, not an error. Every wrapper degrades to a typed result
//      carrying the reason, so the capability ledger can surface it.

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

/** Commands provided by the `termux-api` package, plus the wake-lock pair. */
export const TERMUX_API_COMMANDS = [
  "termux-battery-status",
  "termux-clipboard-get",
  "termux-clipboard-set",
  "termux-notification",
  "termux-notification-remove",
  "termux-open",
  "termux-open-url",
  "termux-share",
  "termux-tts-speak",
  "termux-vibrate",
  "termux-wake-lock",
  "termux-wake-unlock",
] as const;

export type TermuxApiCommand = (typeof TERMUX_API_COMMANDS)[number];

/** Outcome of invoking a Termux command. Never a thrown error. */
export type TermuxCommandResult = {
  ok: boolean;
  /** Resolved absolute path, when the command was found. */
  command?: string;
  stdout: string;
  stderr: string;
  status: number | null;
  /** Why the call did not happen, when it did not. */
  reason?: "not-installed" | "spawn-failed" | "nonzero-exit";
};

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a Termux command to an absolute path.
 *
 * `$PREFIX/bin` is consulted first because it is authoritative for Termux
 * packages; `PATH` is the fallback for a relocated or wrapped install.
 */
export function resolveTermuxCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const prefix = env.PREFIX?.trim();
  if (prefix) {
    const candidate = path.join(prefix, "bin", command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    const dir = entry.trim();
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Reports which `termux-api` commands are installed, without spawning anything. */
export function probeTermuxApi(
  env: NodeJS.ProcessEnv = process.env,
): Record<TermuxApiCommand, string | undefined> {
  const resolved = {} as Record<TermuxApiCommand, string | undefined>;
  for (const command of TERMUX_API_COMMANDS) {
    resolved[command] = resolveTermuxCommand(command, env);
  }
  return resolved;
}

/** True when at least one `termux-api` command is installed. */
export function isTermuxApiInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.values(probeTermuxApi(env)).some((value) => value !== undefined);
}

/**
 * Runs a Termux command, returning a typed result instead of throwing.
 *
 * `timeoutMs` is mandatory in spirit: these commands shell out to the Android
 * framework, which can block indefinitely when the companion app is not
 * installed or is being restricted by the OS.
 */
export function runTermuxCommand(
  command: TermuxApiCommand | string,
  args: readonly string[] = [],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
  } = {},
): TermuxCommandResult {
  const env = options.env ?? process.env;
  const resolved = resolveTermuxCommand(command, env);
  if (!resolved) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      status: null,
      reason: "not-installed",
    };
  }
  try {
    const result = spawnSync(resolved, [...args], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 10_000,
      ...(options.input === undefined ? {} : { input: options.input }),
      // Inherit nothing that could redirect Termux output into a pager.
      env: { ...env, TERM: env.TERM ?? "dumb" },
    });
    if (result.error) {
      return {
        ok: false,
        command: resolved,
        stdout: "",
        stderr: result.error.message,
        status: null,
        reason: "spawn-failed",
      };
    }
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (result.status !== 0) {
      return { ok: false, command: resolved, stdout, stderr, status: result.status, reason: "nonzero-exit" };
    }
    return { ok: true, command: resolved, stdout, stderr, status: result.status };
  } catch (error) {
    return {
      ok: false,
      command: resolved,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      status: null,
      reason: "spawn-failed",
    };
  }
}

/** One battery reading, as reported by `termux-battery-status`. */
export type TermuxBatteryStatus = {
  available: boolean;
  percentage?: number;
  plugged?: string;
  health?: string;
  temperature?: number;
  /** Why no reading was available. */
  reason?: TermuxCommandResult["reason"] | "unparsable";
};

/**
 * Reads battery state, degrading to `available: false` with a reason.
 *
 * Battery state drives resource throttling: a phone on battery and low should
 * not run the same heartbeat and concurrency profile as one on a charger.
 */
export function readTermuxBatteryStatus(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): TermuxBatteryStatus {
  const result = runTermuxCommand("termux-battery-status", [], options);
  if (!result.ok) {
    return { available: false, reason: result.reason };
  }
  try {
    // The command prints a JSON array with one entry per battery.
    const parsed: unknown = JSON.parse(result.stdout);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!entry || typeof entry !== "object") {
      return { available: false, reason: "unparsable" };
    }
    const record = entry as Record<string, unknown>;
    const percentage = typeof record.percentage === "number" ? record.percentage : undefined;
    const plugged = typeof record.plugged === "string" ? record.plugged : undefined;
    const health = typeof record.health === "string" ? record.health : undefined;
    const temperature = typeof record.temperature === "number" ? record.temperature : undefined;
    return {
      available: true,
      ...(percentage === undefined ? {} : { percentage }),
      ...(plugged === undefined ? {} : { plugged }),
      ...(health === undefined ? {} : { health }),
      ...(temperature === undefined ? {} : { temperature }),
    };
  } catch {
    return { available: false, reason: "unparsable" };
  }
}

/**
 * Acquires a partial wake lock so Doze does not suspend the Gateway.
 *
 * This is the single most consequential Termux integration: without it Android
 * stops the process whenever the screen is off, which makes an always-on
 * assistant impossible. Returns whether the lock was taken, or why not.
 */
export function acquireWakeLock(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): TermuxCommandResult {
  return runTermuxCommand("termux-wake-lock", [], options);
}

/** Releases a wake lock acquired by `acquireWakeLock`. */
export function releaseWakeLock(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): TermuxCommandResult {
  return runTermuxCommand("termux-wake-unlock", [], options);
}
