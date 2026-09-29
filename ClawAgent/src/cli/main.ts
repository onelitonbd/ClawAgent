// `clawagent` entry point.
//
// M0 ships three commands: `doctor`, `version`, and `help`. The shape is built
// for the milestones after it — `agent` (M1), `gateway` (M4), `daemon` (M5) —
// which is why command handling is a table and every command receives the same
// resolved context instead of reaching for `process` itself.
//
// Nothing here calls `process.exit`. `runCli` returns an exit code and the thin
// wrapper in `bin/clawagent.mjs` applies it, so the whole CLI is testable
// in-process.

import {
  parseArgv,
  renderUsage,
  type CommandSpec,
  type ParseResult,
} from "./argv.ts";
import { formatDoctorJson, runDoctor } from "./doctor.ts";
import { resolveDefaultClawAgentPaths, logFilePath, type ClawAgentPaths } from "../config/paths.ts";
import { createLogger, parseLogLevel, type Logger } from "../logging/logger.ts";
import { resolvePackageVersion } from "../version.ts";

/** Usage errors: bad flags, unknown commands. */
export const EXIT_USAGE = 2;
/** The host cannot run on this device. */
export const EXIT_UNHEALTHY = 1;
export const EXIT_OK = 0;

export const DOCTOR_COMMAND: CommandSpec = {
  name: "doctor",
  description: "Check this device and report what ClawAgent can do here",
  args: [],
  flags: [
    { name: "skip-battery", type: "boolean", description: "Do not spawn termux-battery-status" },
    {
      name: "storage-path",
      type: "string",
      value: "<dir>",
      description: "Measure free space for this directory instead of the state root",
    },
  ],
};

export const VERSION_COMMAND: CommandSpec = {
  name: "version",
  description: "Print the ClawAgent and Node versions",
  args: [],
  flags: [],
};

export const HELP_COMMAND: CommandSpec = {
  name: "help",
  description: "Show usage for a command",
  args: ["command"],
  flags: [],
};

/** Every command this build knows about. */
export const COMMANDS: readonly CommandSpec[] = [DOCTOR_COMMAND, VERSION_COMMAND, HELP_COMMAND];

/** Minimal stream shape, so tests can capture output without a TTY. */
export type OutputStream = { write(chunk: string): unknown };

export type CliContext = {
  /** Arguments after the program name. Defaults to none, for embedding. */
  argv?: readonly string[];
  stdout?: OutputStream;
  stderr?: OutputStream;
  env?: NodeJS.ProcessEnv;
  /** Injectable version, for tests. */
  version?: string;
};

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagBoolean(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

/** Resolves state paths, honouring `--home` over the environment. */
export function resolvePathsForCli(
  parsed: ParseResult,
  env: NodeJS.ProcessEnv,
): ClawAgentPaths | undefined {
  const override = flagString(parsed.flags, "home");
  if (override) {
    return resolveDefaultClawAgentPaths({ ...env, CLAWAGENT_HOME: override });
  }
  return resolveDefaultClawAgentPaths(env);
}

/** Writes the version, as JSON when asked. Shared by `--version` and `version`. */
function emitVersion(
  parsed: ParseResult,
  version: string,
  stdout: OutputStream,
  write: (stream: OutputStream, lines: readonly string[]) => void,
): void {
  const payload = {
    clawagent: version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
  if (flagBoolean(parsed.flags, "json")) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  write(stdout, [
    `clawagent ${payload.clawagent}`,
    `node ${payload.node} (${payload.platform}/${payload.arch})`,
  ]);
}

/** Runs the CLI and returns everything it produced. */
export function runCli(options: CliContext = {}): CliResult {
  const env = options.env ?? process.env;
  const out: string[] = [];
  const err: string[] = [];
  const stdout: OutputStream = options.stdout ?? { write: (chunk) => out.push(String(chunk)) };
  const stderr: OutputStream = options.stderr ?? { write: (chunk) => err.push(String(chunk)) };
  const version = options.version ?? resolvePackageVersion();

  const parsed = parseArgv(options.argv ?? [], COMMANDS);
  const write = (stream: OutputStream, lines: readonly string[]): void => {
    for (const line of lines) {
      stream.write(`${line}\n`);
    }
  };

  // Usage errors win over everything else: reporting a healthy device after a
  // mistyped command would hide the real problem.
  if (parsed.errors.length > 0) {
    write(stderr, parsed.errors);
    write(stderr, ["", ...renderUsage(COMMANDS, undefined)]);
    return { exitCode: EXIT_USAGE, stdout: out.join(""), stderr: err.join("") };
  }

  if (parsed.version) {
    emitVersion(parsed, version, stdout, write);
    return { exitCode: EXIT_OK, stdout: out.join(""), stderr: err.join("") };
  }

  if (parsed.help || parsed.command === undefined || parsed.command === "help") {
    const topic = parsed.command === "help" ? parsed.positionals[0] : parsed.command;
    write(stdout, renderUsage(COMMANDS, topic));
    return { exitCode: EXIT_OK, stdout: out.join(""), stderr: err.join("") };
  }

  // `version` is answered before paths and logging are set up: printing a
  // version must not create a state directory or write a log line.
  if (parsed.command === "version") {
    emitVersion(parsed, version, stdout, write);
    return { exitCode: EXIT_OK, stdout: out.join(""), stderr: err.join("") };
  }

  const paths = resolvePathsForCli(parsed, env);
  const level = parseLogLevel(flagString(parsed.flags, "log-level"));
  const logger: Logger = createLogger({
    scope: "cli",
    level,
    stream: stderr,
    ...(paths ? { file: logFilePath(paths, "clawagent") } : {}),
  });

  if (parsed.command === "doctor") {
    logger.debug("doctor starting", { level });
    const report = runDoctor({
      env,
      // Pass the CLI-resolved paths so `--home` changes what doctor reports,
      // not just where doctor logs.
      ...(paths ? { paths } : {}),
      ...(flagBoolean(parsed.flags, "skip-battery") ? { skipBattery: true } : {}),
      ...(flagString(parsed.flags, "storage-path")
        ? { storagePath: flagString(parsed.flags, "storage-path") }
        : {}),
    });
    if (flagBoolean(parsed.flags, "json")) {
      stdout.write(`${formatDoctorJson(report)}\n`);
    } else {
      write(stdout, report.lines);
    }
    logger.info("doctor finished", { startable: report.ledger.startable });
    logger.close();
    return {
      exitCode: report.ledger.startable ? EXIT_OK : EXIT_UNHEALTHY,
      stdout: out.join(""),
      stderr: err.join(""),
    };
  }

  // Unreachable while parseArgv rejects unknown commands, but a command added to
  // COMMANDS without a handler must fail loudly rather than exit 0.
  write(stderr, [`command "${parsed.command}" is not implemented in this build`, ""]);
  write(stderr, renderUsage(COMMANDS, undefined));
  logger.close();
  return { exitCode: EXIT_USAGE, stdout: out.join(""), stderr: err.join("") };
}
