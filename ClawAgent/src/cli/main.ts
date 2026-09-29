// `clawagent` entry point.
//
// M0 shipped `doctor`, `version`, and `help`; M1 adds `chat`. The shape is built
// for the milestones after it — `agent` (M2), `gateway` (M4), `daemon` (M5) —
// which is why command handling is a table and every command receives the same
// resolved context instead of reaching for `process` itself.
//
// `runCli` is async from M1 onward. Streaming a model reply cannot be
// synchronous, and every later command (agent loop, gateway, daemon) is async
// too, so making the dispatcher async now avoids a second breaking change.
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
import {
  AGENT_COMMAND,
  runAgent,
} from "./agent.ts";
import {
  CHAT_COMMAND,
  createReadlinePrompter,
  mergeModelFlagOverrides,
  runChat,
  type ChatPrompter,
} from "./chat.ts";
import { resolveConfig } from "../config/config.ts";
import type { ChatRuntime } from "../provider/runtime.ts";
import { resolveDefaultClawAgentPaths, logFilePath, type ClawAgentPaths } from "../config/paths.ts";
import { createLogger, parseLogLevel, type Logger } from "../logging/logger.ts";
import { resolvePackageVersion } from "../version.ts";

// Exit codes live in their own module so command modules can use them without
// importing this file, which would be a cycle. Re-exported for callers that
// already reach for them here.
export {
  EXIT_CONFIG,
  EXIT_OK,
  EXIT_PROVIDER,
  EXIT_UNHEALTHY,
  EXIT_USAGE,
} from "./exit-codes.ts";
import { EXIT_CONFIG, EXIT_OK, EXIT_PROVIDER, EXIT_UNHEALTHY, EXIT_USAGE } from "./exit-codes.ts";

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
export const COMMANDS: readonly CommandSpec[] = [
  AGENT_COMMAND,
  CHAT_COMMAND,
  DOCTOR_COMMAND,
  VERSION_COMMAND,
  HELP_COMMAND,
];

// Re-exported so existing imports keep working; the definition lives in
// `streams.ts` to keep command modules from depending on the dispatcher.
export type { OutputStream } from "./streams.ts";
import { writeLines as writeLinesTo, type OutputStream } from "./streams.ts";

export type CliContext = {
  /** Arguments after the program name. Defaults to none, for embedding. */
  argv?: readonly string[];
  stdout?: OutputStream;
  stderr?: OutputStream;
  env?: NodeJS.ProcessEnv;
  /** Injectable version, for tests. */
  version?: string;
  /** Injectable chat prompter; without it `chat` requires `--message`. */
  prompter?: ChatPrompter;
  /** Injectable model runtime factory, so tests never reach the network. */
  chatRuntimeFactory?: () => Promise<ChatRuntime>;
  /**
   * Same injection for `agent`. One option per command rather than a shared one,
   * because a test that swaps the runtime for `chat` and then exercises `agent`
   * would otherwise silently run the fake against a command it was never written
   * for.
   */
  agentRuntimeFactory?: () => Promise<ChatRuntime>;
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
    // Which flags this process actually started with. On a phone this is the
    // difference between "the transform flag is missing" and an hour of guessing
    // why a reused core file failed to load.
    execArgv: process.execArgv,
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
export async function runCli(options: CliContext = {}): Promise<CliResult> {
  const env = options.env ?? process.env;
  const out: string[] = [];
  const err: string[] = [];
  const stdout: OutputStream = options.stdout ?? { write: (chunk) => out.push(String(chunk)) };
  const stderr: OutputStream = options.stderr ?? { write: (chunk) => err.push(String(chunk)) };
  const version = options.version ?? resolvePackageVersion();

  const parsed = parseArgv(options.argv ?? [], COMMANDS);
  const write = writeLinesTo;

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

  if (parsed.command === "chat") {
    logger.debug("chat starting");
    const message = flagString(parsed.flags, "message");
    // A prompter is only built when stdin will actually be read: creating a
    // readline interface over a pipe that is never consumed would leave the
    // process waiting on input it never asked for.
    const prompter =
      options.prompter ??
      (message === undefined
        ? createReadlinePrompter({ input: process.stdin, output: stdout, prompt: "> " })
        : undefined);
    const config = mergeModelFlagOverrides(resolveConfig(paths, env), parsed.flags);
    const systemPrompt = flagString(parsed.flags, "system");
    const chat = await runChat({
      env,
      stdout,
      stderr,
      config,
      ...(paths ? { paths } : {}),
      ...(message === undefined ? {} : { message }),
      ...(prompter ? { prompter } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(flagBoolean(parsed.flags, "show-thinking") ? { showThinking: true } : {}),
      ...(options.chatRuntimeFactory ? { runtimeFactory: options.chatRuntimeFactory } : {}),
    });
    logger.info("chat finished", { turns: chat.replies.length, exitCode: chat.exitCode });
    logger.close();
    return { exitCode: chat.exitCode, stdout: out.join(""), stderr: err.join("") };
  }

  if (parsed.command === "agent") {
    logger.debug("agent starting");
    const message = flagString(parsed.flags, "message");
    const config = mergeModelFlagOverrides(resolveConfig(paths, env), parsed.flags);
    // A prompter is built for both modes here, unlike `chat`: the approval gate
    // reads from the same input, so even `agent -m "..."` may have to ask. When
    // nothing asks, the run still has to close it, or the process waits on a
    // stream nobody will write to again.
    const prompter =
      options.prompter ??
      createReadlinePrompter({ input: process.stdin, output: stdout, prompt: "> " });
    const systemPrompt = flagString(parsed.flags, "system");
    const approve = flagString(parsed.flags, "approve");
    const workspace = flagString(parsed.flags, "workspace");
    const maxTurns = flagString(parsed.flags, "max-turns");
    let agent: Awaited<ReturnType<typeof runAgent>>;
    try {
      agent = await runAgent({
        env,
        stdout,
        stderr,
        config,
        prompter,
        ...(message === undefined ? {} : { message }),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(approve ? { approve } : {}),
        ...(workspace ? { workspace } : {}),
        ...(maxTurns ? { maxTurns } : {}),
        ...(flagBoolean(parsed.flags, "yes") ? { yes: true } : {}),
        ...(flagBoolean(parsed.flags, "show-thinking") ? { showThinking: true } : {}),
        ...(flagBoolean(parsed.flags, "dry-run") ? { dryRun: true } : {}),
        ...(options.agentRuntimeFactory ? { runtimeFactory: options.agentRuntimeFactory } : {}),
      });
    } finally {
      prompter.close();
    }
    logger.info("agent finished", { runs: agent.replies.length, toolCalls: agent.toolCalls, exitCode: agent.exitCode });
    logger.close();
    return { exitCode: agent.exitCode, stdout: out.join(""), stderr: err.join("") };
  }

  // Unreachable while parseArgv rejects unknown commands, but a command added to
  // COMMANDS without a handler must fail loudly rather than exit 0.
  write(stderr, [`command "${parsed.command}" is not implemented in this build`, ""]);
  write(stderr, renderUsage(COMMANDS, undefined));
  logger.close();
  return { exitCode: EXIT_USAGE, stdout: out.join(""), stderr: err.join("") };
}
