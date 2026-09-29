// bash — run a program, capture both streams, never via a shell.
//
// Three decisions that differ from a desktop agent, all of them about the device:
//
// 1. `spawn(program, argv)` after resolving argv[0] through `$PATH`. A shell is
//    unavailable (`/bin/sh` does not exist on Termux) and unwanted: see
//    ../../util/command-argv.ts. A command line with operators is refused with
//    the alternative spelled out.
// 2. The child gets its own process group (`detached`) and dies with it. Killing
//    only the direct child is how `npm test` on a phone leaves a dozen node
//    processes chewing the battery after the tool "finished". The group kill goes
//    through `agent-core`'s kill-tree helper, which verifies the PID is really
//    its own group leader before signalling `(-pid)` — so a mistake cannot take
//    out ClawAgent's own process group.
// 3. A non-zero exit is a *result*, not a tool failure. Throwing would drop
//    stdout, and stdout is the whole reason to run `pytest -x`. Only refusing to
//    start (no such program, bad path, unsupported operator) throws.
//
// `stdin` is ignored rather than piped: a command that waits for input on a
// device with no visible prompt hangs until the timeout and looks like a ClawAgent
// bug.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@openclaw/agent-core";
import { killProcessTree } from "@openclaw/agent-core/harness/env/kill-tree";
import { splitCommandLine } from "../util/command-argv.ts";
import { DEFAULT_OUTPUT_CAPS, resolveToolPath, type Workspace } from "./workspace.ts";

const BashParams = Type.Object(
  {
    command: Type.String({
      description:
        "Program and arguments, e.g. `git status --short`. No shell features: no pipes, redirection, `;`, or `$()`.",
    }),
    cwd: Type.Optional(Type.String({ description: "Working directory, relative to the workspace root" })),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 100,
        maximum: 600_000,
        description: "Kill the process tree after this long (default 60000)",
      }),
    ),
  },
  { additionalProperties: false },
);

export type BashToolOptions = {
  workspace: Workspace;
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  /** Overrides for tests; production uses the real spawn. */
  spawnImpl?: typeof spawn;
};

export function createBashTool(options: BashToolOptions): AgentTool<typeof BashParams> {
  const env = options.env ?? process.env;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_CAPS.commandBytes;
  const spawnImpl = options.spawnImpl ?? spawn;

  return {
    label: "Bash",
    name: "bash",
    description:
      "Run a program with arguments and return stdout, stderr, and the exit code. No shell: no pipes, redirection, or command substitution. Long output is capped.",
    parameters: BashParams,
    executionMode: "sequential",
    execute: async (
      _id,
      params: Static<typeof BashParams>,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> => {
      const split = splitCommandLine(params.command);
      if (!split.ok) {
        throw new Error(
          `${split.error}${split.hint ? ` — ${split.hint}` : ""}`,
        );
      }
      const cwd = params.cwd ? resolveToolPath(options.workspace, params.cwd, "working directory") : options.workspace.root;
      const [program, ...args] = split.argv;
      if (!program) {
        throw new Error("command is empty");
      }
      const resolved = resolveExecutable(program, { cwd, env, workspace: options.workspace });
      if (!resolved.ok) {
        throw new Error(resolved.error);
      }

      const timeoutMs = params.timeoutMs ?? defaultTimeoutMs;
      const outcome = await runProcess({
        spawn: spawnImpl,
        file: resolved.file,
        args,
        cwd,
        env,
        timeoutMs,
        maxOutputBytes,
        ...(signal ? { signal } : {}),
      });

      const sections: string[] = [];
      if (outcome.stdout.trim()) {
        sections.push(`stdout:\n${outcome.stdout}`);
      }
      if (outcome.stderr.trim()) {
        sections.push(`stderr:\n${outcome.stderr}`);
      }
      const status = outcome.killedBy
        ? `killed by ${outcome.killedBy} after ${outcome.durationMs} ms${outcome.timedOut ? " (timeout; raise timeoutMs if the command is legitimately slow)" : ""}`
        : `exit code ${outcome.code ?? "none"}/${outcome.signal ?? "no signal"} in ${outcome.durationMs} ms`;
      const body = sections.length === 0 ? `(${status}, no output)` : `${sections.join("\n\n")}\n\n${status}`;
      // No second cap on the assembled body: both streams are already bounded at
      // construction, and re-truncating here would cut off the very note that
      // says output was cut.
      return {
        content: [{ type: "text", text: body }],
        details: {
          argv: [program, ...args],
          cwd,
          code: outcome.code,
          signal: outcome.signal,
          timedOut: outcome.timedOut,
          durationMs: outcome.durationMs,
        },
      };
    },
  };
}

type RunParams = {
  spawn: typeof spawn;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
};

type RunOutcome = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killedBy: string | undefined;
  durationMs: number;
};

/**
 * Runs one program to completion.
 *
 * Output is capped per stream while accumulating, not at the end: a runaway
 * `yes` writing gigabytes to stdout would otherwise be buffered in memory
 * first, and out-of-memory on Android is a silent kill of the whole host rather
 * than an error message.
 */
async function runProcess(params: RunParams): Promise<RunOutcome> {
  const startedAt = Date.now();
  const child = params.spawn(params.file, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group, so the tree dies together. Windows ignores this.
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  const stdout = capBuffer(child.stdout, params.maxOutputBytes);
  const stderr = capBuffer(child.stderr, params.maxOutputBytes);
  let timedOut = false;
  let killedBy: string | undefined;

  const killer = () => {
    // `detached: true` on our side means the group is ours to signal. A child
    // that failed to spawn has no pid, and 0 is what the helper rejects — which
    // is the correct outcome here: there is nothing to kill, and killing the
    // process group we belong to would take ClawAgent with it.
    const tree = killProcessTree(child.pid ?? 0, { detached: true, graceMs: 1_000, force: true });
    if (!tree) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killedBy = "timeout";
    killer();
  }, params.timeoutMs);
  const abort = (): void => {
    killedBy = "abort";
    killer();
  };
  params.signal?.addEventListener("abort", abort, { once: true });
  if (params.signal?.aborted) {
    abort();
  }

  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  try {
    const settled = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    });
    code = settled.code;
    signal = settled.signal;
  } catch (error) {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", abort);
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`command not found: ${params.file}`);
    }
    if ((error as NodeJS.ErrnoException).code === "EACCES") {
      throw new Error(`not executable: ${params.file}`);
    }
    throw new Error(`could not run ${params.file}: ${message}`);
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", abort);
  }

  await Promise.all([stdout.done, stderr.done]);
  return {
    stdout: stdout.text() + (stdout.dropped > 0 ? `\n[stdout truncated: ${stdout.dropped} bytes dropped]` : ""),
    stderr: stderr.text() + (stderr.dropped > 0 ? `\n[stderr truncated: ${stderr.dropped} bytes dropped]` : ""),
    code,
    signal,
    timedOut,
    killedBy,
    durationMs: Date.now() - startedAt,
  };
}

function capBuffer(stream: NodeJS.ReadableStream | null, maxBytes: number): {
  text: () => string;
  dropped: number;
  done: Promise<void>;
} {
  const chunks: Buffer[] = [];
  let kept = 0;
  let dropped = 0;
  const done = new Promise<void>((resolve) => {
    if (!stream) {
      resolve();
      return;
    }
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (kept >= maxBytes) {
        dropped += buffer.length;
        return;
      }
      const room = maxBytes - kept;
      if (buffer.length <= room) {
        chunks.push(buffer);
        kept += buffer.length;
        return;
      }
      chunks.push(buffer.subarray(0, room));
      kept += room;
      dropped += buffer.length - room;
    });
    stream.on("end", resolve);
    stream.on("error", resolve);
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
    get dropped() {
      return dropped;
    },
    done,
  };
}

/**
 * Finds the program argv[0] names.
 *
 * `$PATH` is the only search path, because on Termux it is the only correct one:
 * the prefix moves between app installs and hardcoding `/usr/bin` finds nothing
 * at all. A name containing a slash is resolved against the working directory,
 * which is how `./node_modules/.bin/vitest` and `$PREFIX/bin/termux-toast` both
 * work.
 */
export function resolveExecutable(
  program: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; workspace: Workspace },
): { ok: true; file: string } | { ok: false; error: string } {
  if (!program) {
    return { ok: false, error: "command is empty" };
  }
  if (program.includes("/") || path.isAbsolute(program)) {
    const candidate = path.isAbsolute(program) ? program : path.resolve(options.cwd, program);
    let scoped = candidate;
    if (options.workspace.policy === "strict") {
      try {
        scoped = resolveToolPath(options.workspace, candidate, "command path");
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!isExecutableFile(scoped)) {
      return { ok: false, error: `not an executable file: ${scoped}` };
    }
    return { ok: true, file: scoped };
  }

  const entries = (options.env.PATH ?? options.env.path ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, program);
    if (isExecutableFile(candidate)) {
      return { ok: true, file: candidate };
    }
  }
  return { ok: false, error: missingCommandMessage(program, options.env) };
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Termux knows how to install what it is missing, so say so.
 *
 * The generic "command not found" answer sends someone to a search engine; the
 * package name is one line. This list is deliberately short — only tools a model
 * reaches for constantly, and only where the Termux package name is not the
 * binary name.
 */
const TERMUX_PACKAGES: Readonly<Record<string, string>> = {
  rg: "ripgrep",
  fd: "fd",
  bat: "bat",
  jq: "jq",
  python: "python",
  python3: "python",
  pip: "python-pip",
  pip3: "python-pip",
  ffmpeg: "ffmpeg",
  convert: "imagemagick",
  magick: "imagemagick",
  curl: "curl",
  wget: "wget",
  make: "make",
  cmake: "cmake",
  gcc: "clang",
  clang: "clang",
  tesseract: "tesseract",
  gh: "gh",
  sqlite3: "sqlite",
};

function missingCommandMessage(program: string, env: NodeJS.ProcessEnv): string {
  const pkg = TERMUX_PACKAGES[program];
  const prefix = env.PREFIX?.trim();
  const lines = [`command not found: ${program}`];
  if (pkg) {
    lines.push(`install it on Termux with: pkg install ${pkg}`);
  }
  if (!prefix) {
    lines.push("$PREFIX is unset, so this does not look like Termux; PATH was searched but found nothing");
  }
  return lines.join("; ");
}
