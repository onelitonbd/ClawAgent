// `clawagent agent` — a multi-turn, tool-using session in the terminal.
//
// HOW IT DIFFERS FROM `chat`
//
// `chat` sends a message and streams text back. `agent` hands the same model a
// workspace and lets it act: read files, edit them, run programs — asking first
// for anything that changes something. That difference is three things `chat` has
// no equivalent of: the tool set, an approval gate sharing the same input stream,
// and one user message expanding into many provider turns.
//
// Why they are two commands rather than one with a flag: an agent that edits
// files needs its own defaults (system prompt, approval mode, workspace) and its
// own exit semantics, and folding them together would give every plain chat
// invocation the risk surface of the tool layer.
//
// The one-shot form (`agent -m "..."`) is not a demo convenience. It is how this
// milestone is proven without a TTY, and how a Termux user wires the agent into a
// cron job or a `termux-boot` script.

import type { AgentSession } from "../agent/runner.ts";
import {
  AGENT_SYSTEM_PROMPT,
  createAgentSession,
  toolOptionsForMode,
  type AgentTurnEvent,
} from "../agent/runner.ts";
import { APPROVAL_MODES, parseApprovalMode, type ApprovalMode } from "../approvals/policy.ts";
import { explainTurnError } from "../provider/errors.ts";
// Type-only on purpose: the tool layer itself is imported at the use site
// below. Statically it would drag `typebox` and the whole `@openclaw/agent-core`
// graph into `src/cli/main.ts`, and `clawagent help`, `version`, and `doctor`
// would then fail on a checkout that has not installed anything yet - the state
// `doctor` exists to explain. See test/boundary.test.ts for the enforced rule.
import type { BuildToolOptions } from "../tools/index.ts";
import type { CommandSpec } from "./argv.ts";
import { createReadlinePrompter, startModelSession, type ChatOptions, type ChatPrompter } from "./chat.ts";
import { EXIT_CONFIG, EXIT_OK, EXIT_PROVIDER, EXIT_USAGE } from "./exit-codes.ts";
import { isTTY, writeLines as writeLinesTo, type OutputStream } from "./streams.ts";

export type AgentOptions = {
  env?: NodeJS.ProcessEnv;
  stdout?: OutputStream;
  stderr?: OutputStream;
  prompter?: ChatPrompter;
  /** One-shot input. When set, exactly one run happens and no prompter is needed. */
  message?: string;
  workspace?: string;
  approve?: string;
  /** `--yes`: skip routine prompts. Destructive and credential checks still hold. */
  yes?: boolean;
  /** Prints the plan (workspace, tools, mode) and exits without a model call. */
  dryRun?: boolean;
  systemPrompt?: string;
  showThinking?: boolean;
  /** Provider turns per message; guards against a loop that never converges. */
  maxTurns?: string;
  /** Injected for tests; production builds the real runtime. */
  /** Injected runtime factory; tests supply a fake so no network is touched. */
  runtimeFactory?: ChatOptions["runtimeFactory"];
  /** Tool-set override, for tests and for later milestones. */
  tools?: BuildToolOptions;
  config?: ChatOptions["config"];
  paths?: ChatOptions["paths"];
};

export type AgentResult = {
  exitCode: number;
  /** Assistant text per completed run. */
  replies: string[];
  toolCalls: number;
  /** Lines the command printed outside the stream, for tests and `--dry-run`. */
  notes: string[];
};

export const AGENT_COMMAND: CommandSpec = {
  name: "agent",
  description: "Run an agent that can read, edit, and run things in a workspace",
  args: [],
  flags: [
    {
      name: "message",
      alias: "m",
      type: "string",
      value: "<text>",
      description: "Run one task and exit",
    },
    { name: "model", type: "string", value: "<id>", description: "Model id for this run" },
    { name: "provider", type: "string", value: "<id>", description: "Provider preset for this run" },
    { name: "base-url", type: "string", value: "<url>", description: "Endpoint for this run" },
    { name: "api", type: "string", value: "<adapter>", description: "Protocol adapter" },
    {
      name: "workspace",
      type: "string",
      value: "<dir>",
      description: "Directory the agent may work in (default: current directory)",
    },
    {
      name: "approve",
      type: "string",
      value: "<mode>",
      description: `Approval mode: ${APPROVAL_MODES.join(" | ")} (default: ask)`,
    },
    {
      name: "yes",
      type: "boolean",
      description: "Do not ask for routine changes; dangerous operations are still refused",
    },
    {
      name: "max-turns",
      type: "string",
      value: "<n>",
      description: "Provider turns per message before stopping (default 24, max 200)",
    },
    {
      name: "system",
      alias: "s",
      type: "string",
      value: "<text>",
      description: "System prompt override",
    },
    { name: "show-thinking", type: "boolean", description: "Print reasoning deltas as they stream" },
    { name: "dry-run", type: "boolean", description: "Show the workspace, tools, and mode; call nothing" },
  ],
};

/** Commands accepted at the `agent` prompt. */
export const AGENT_PROMPT_COMMANDS: readonly { name: string; description: string }[] = [
  { name: "/help", description: "show these commands" },
  { name: "/tools", description: "list the tools available this run" },
  { name: "/workspace", description: "print the workspace root and path policy" },
  { name: "/approve <mode>", description: `change approval mode (${APPROVAL_MODES.join(", ")})` },
  { name: "/exit", description: "quit" },
];

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "ask";
export const DEFAULT_MAX_TURNS = 24;
export const MAX_TURNS_LIMIT = 200;

export type ResolvedAgentFlags = {
  mode: ApprovalMode;
  workspace: string | undefined;
  maxTurns: number;
  error: string | undefined;
};

/**
 * Interprets the approval-related flags over config.
 *
 * `--yes` and `--approve` both move one dial, and combining them is refused
 * instead of resolved: a rule that quietly picked a winner would let a flag that
 * *tightens* be overridden by one that loosens, depending on parse order.
 */
export function resolveAgentFlags(input: {
  approve?: string | undefined;
  yes?: boolean | undefined;
  maxTurns?: string | undefined;
  workspace?: string | undefined;
  modeFromConfig?: string | undefined;
  workspaceFromConfig?: string | undefined;
  maxTurnsFromConfig?: number | undefined;
}): ResolvedAgentFlags {
  let error: string | undefined;
  if (input.approve !== undefined && input.yes) {
    error = "--yes and --approve cannot be combined; use --approve full if that is what you meant";
  }
  let mode: ApprovalMode = DEFAULT_APPROVAL_MODE;
  if (!error) {
    const requested = input.approve ?? (input.yes ? "full" : (input.modeFromConfig ?? ""));
    if (input.approve !== undefined || input.yes) {
      const parsed = parseApprovalMode(requested);
      if (!parsed) {
        error = `unknown approval mode "${requested?.trim() ?? ""}"; expected ${APPROVAL_MODES.join(", ")}`;
      } else {
        mode = parsed;
      }
    } else if (input.modeFromConfig !== undefined) {
      const parsed = parseApprovalMode(input.modeFromConfig);
      if (!parsed) {
        error = `agent.approve in config is "${input.modeFromConfig}"; expected ${APPROVAL_MODES.join(", ")}`;
      } else {
        mode = parsed;
      }
    }
  }

  let maxTurns = input.maxTurnsFromConfig ?? DEFAULT_MAX_TURNS;
  if (input.maxTurns !== undefined && !error) {
    const parsed = Number(input.maxTurns);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TURNS_LIMIT) {
      error = `--max-turns must be a whole number from 1 to ${MAX_TURNS_LIMIT}`;
    } else {
      maxTurns = parsed;
    }
  }

  const workspace = input.workspace?.trim() || input.workspaceFromConfig?.trim() || undefined;
  return { mode, workspace, maxTurns, error };
}

/** The plan `--dry-run` prints, and what tests assert on. */
export function describeAgentPlan(input: {
  workspaceRoot: string;
  policy: string;
  mode: ApprovalMode;
  tools: readonly string[];
  modelLabel: string;
  maxTurns: number;
}): string[] {
  return [
    `workspace: ${input.workspaceRoot} (${input.policy} paths)`,
    `approval : ${input.mode}`,
    `model    : ${input.modelLabel}`,
    `tools    : ${input.tools.join(", ") || "(none)"}`,
    `turns    : up to ${input.maxTurns} per message`,
    "",
    "no model call was made",
  ];
}

type RenderState = { inThinking: boolean; atLineStart: boolean };

/**
 * Renders loop events while a run is live.
 *
 * Tool lines are kept on their own lines and the assistant text is never
 * interleaved mid-sentence, because a person reading this on a phone cannot tell
 * a streamed sentence with a log line dropped into it apart from a broken
 * response.
 */
export function renderAgentEvent(
  event: AgentTurnEvent,
  stdout: OutputStream,
  colour: boolean,
  showThinking: boolean,
  state: RenderState,
): void {
  const dim = (text: string): string => (colour ? `\x1b[2m${text}\x1b[22m` : text);
  const closeThinking = (): void => {
    if (state.inThinking) {
      stdout.write(colour ? "\x1b[22m\n" : "\n");
      state.inThinking = false;
    }
  };
  switch (event.type) {
    case "assistant-text":
      closeThinking();
      if (!state.atLineStart) {
        // A tool line ended without a newline; do not glue prose onto it.
        stdout.write("\n");
        state.atLineStart = true;
      }
      stdout.write(event.delta);
      return;
    case "thinking":
      if (!showThinking) {
        return;
      }
      if (!state.inThinking) {
        stdout.write(dim("thinking:\n"));
        state.inThinking = true;
      }
      stdout.write(event.delta);
      return;
    case "tool-start":
      closeThinking();
      state.atLineStart = false;
      stdout.write(dim(`\n… ${event.toolName}\n`));
      return;
    case "tool-end":
      state.atLineStart = false;
      stdout.write(dim(`${event.ok ? "done" : "failed"}: ${event.toolName}\n`));
      return;
    case "failed":
      closeThinking();
      state.atLineStart = true;
      stdout.write(`\n${event.error}\n`);
      return;
    default:
      return;
  }
}

/** Runs the `agent` command. */
export async function runAgent(options: AgentOptions = {}): Promise<AgentResult> {
  const env = options.env ?? process.env;
  const stdout: OutputStream = options.stdout ?? process.stdout;
  const stderr: OutputStream = options.stderr ?? process.stderr;
  const notes: string[] = [];
  const replies: string[] = [];
  const colour = isTTY(stdout) && !env.NO_COLOR;
  const writeLine = (text: string): void => {
    notes.push(text);
    stdout.write(`${text}\n`);
  };
  const empty = (toolCalls = 0): AgentResult => ({ exitCode: EXIT_OK, replies, toolCalls, notes });

  // `config` is a *resolved* config: the section lives one level down. Reading
  // `options.config.agent` would type-check as `any`-ish in a looser type and is
  // the kind of mistake a ResolvedConfig-shaped option invites.
  const agentConfig = options.config?.config?.agent;
  const flags = resolveAgentFlags({
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    ...(options.yes === undefined ? {} : { yes: options.yes }),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(agentConfig?.approve === undefined ? {} : { modeFromConfig: agentConfig.approve }),
    ...(agentConfig?.workspace === undefined ? {} : { workspaceFromConfig: agentConfig.workspace }),
    ...(agentConfig?.maxTurns === undefined ? {} : { maxTurnsFromConfig: agentConfig.maxTurns }),
  });
  if (flags.error) {
    writeLinesTo(stderr, [`error: ${flags.error}`, "       see: clawagent agent --help"]);
    return { exitCode: EXIT_USAGE, replies, toolCalls: 0, notes };
  }

  const oneShot = options.message !== undefined;
  if (oneShot && !options.message?.trim()) {
    writeLinesTo(stderr, ["error: -m needs a non-empty message", "       see: clawagent agent --help"]);
    return { exitCode: EXIT_USAGE, replies, toolCalls: 0, notes };
  }
  const interactive = !oneShot && !options.dryRun;
  if (interactive && !options.prompter) {
    writeLinesTo(stderr, [
      "error: interactive agent needs a terminal",
      '       pass -m "..." for one run, or run from a TTY',
    ]);
    return { exitCode: EXIT_USAGE, replies, toolCalls: 0, notes };
  }

  const startup = await startModelSession(
    {
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.paths === undefined ? {} : { paths: options.paths }),
      ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      defaultSystemPrompt: AGENT_SYSTEM_PROMPT,
      ...(options.showThinking === undefined ? {} : { showThinking: options.showThinking }),
    },
    env,
    stderr,
  );
  if (!startup.ok) {
    writeLinesTo(stderr, startup.lines);
    return { exitCode: startup.exitCode, replies, toolCalls: 0, notes };
  }

  const toolOptions: BuildToolOptions = {
    ...(options.tools ?? {}),
    ...(flags.workspace ? { root: flags.workspace } : {}),
  };

  if (options.dryRun) {
    // The real tool builder, not a description of it: what this prints is what a
    // run would have had, including the workspace canonicalisation.
    const { buildWorkspaceTools } = await import("../tools/index.ts");
    const built = buildWorkspaceTools(toolOptionsForMode(flags.mode, toolOptions));
    for (const line of describeAgentPlan({
      workspaceRoot: built.workspace.root,
      policy: built.workspace.policy,
      mode: flags.mode,
      tools: built.tools.map((tool) => tool.name),
      modelLabel: startup.providerLabel,
      maxTurns: flags.maxTurns,
    })) {
      writeLine(line);
    }
    return { ...empty(), exitCode: EXIT_OK };
  }

  const prompter =
    options.prompter ??
    createReadlinePrompter({ input: process.stdin, output: process.stdout, prompt: "> " });
  const state: RenderState = { inThinking: false, atLineStart: true };
  let session: AgentSession;
  try {
    session = await createAgentSession({
      model: startup.model,
      runtime: startup.runtime,
      apiKey: startup.key,
      mode: flags.mode,
      systemPrompt: startup.systemPrompt,
      maxTurns: flags.maxTurns,
      input: prompter,
      output: { write: (text) => stdout.write(text) },
      colour,
      ...(startup.options ? { streamOptions: startup.options } : {}),
      tools: toolOptions,
      onEvent: (event) => {
        renderAgentEvent(event, stdout, colour, options.showThinking === true, state);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLinesTo(stderr, [`error: could not start the agent: ${message}`]);
    return { exitCode: EXIT_PROVIDER, replies, toolCalls: 0, notes };
  }

  let toolCalls = 0;
  const runOnce = async (input: string): Promise<number> => {
    const outcome = await session.prompt(input);
    toolCalls += outcome.toolCalls;
    if (outcome.ok) {
      if (outcome.text) {
        stdout.write("\n");
      }
      state.atLineStart = true;
      if (outcome.stoppedReason) {
        writeLine(`(${outcome.stoppedReason}; the task may be unfinished)`);
      }
      replies.push(outcome.text);
      return EXIT_OK;
    }
    if (!oneShot) {
      // A failed turn inside an interactive run keeps the session: the transcript
      // is still useful, and a dropped mobile connection is routine.
      stdout.write(`\n${outcome.error ?? "the model turn failed"}\n`);
      state.atLineStart = true;
      return EXIT_OK;
    }
    const explained = explainTurnError(outcome.error ?? "the model turn failed", startup.model);
    writeLinesTo(stderr, [explained.message, ...(explained.hint ? [`       ${explained.hint}`] : [])]);
    return EXIT_PROVIDER;
  };

  try {
    if (oneShot) {
      const code = await runOnce(options.message ?? "");
      return { exitCode: code, replies, toolCalls, notes };
    }
    writeLine(
      `workspace ${session.workspaceRoot} · approval ${flags.mode} · /help for commands`,
    );
    for (;;) {
      const line = await prompter.next();
      if (line === undefined) {
        break;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed === "/exit" || trimmed === "/quit") {
        break;
      }
      if (trimmed === "/help") {
        for (const entry of AGENT_PROMPT_COMMANDS) {
          writeLine(`  ${entry.name.padEnd(20)} ${entry.description}`);
        }
        continue;
      }
      if (trimmed === "/tools") {
        writeLine(session.tools.map((tool) => tool.name).join(", ") || "(none)");
        continue;
      }
      if (trimmed === "/workspace") {
        writeLine(session.workspaceRoot);
        continue;
      }
      if (trimmed === "/approve" || trimmed.startsWith("/approve ")) {
        const requested = trimmed.slice("/approve".length).trim();
        const parsed = parseApprovalMode(requested);
        if (!parsed) {
          writeLine(`usage: /approve <${APPROVAL_MODES.join("|")}>`);
          continue;
        }
        session.gate.setMode(parsed);
        writeLine(`approval mode is now ${parsed} (grants from the previous mode were dropped)`);
        continue;
      }
      if (trimmed.startsWith("/")) {
        writeLine(`unknown command ${trimmed}; /help lists what exists`);
        continue;
      }
      state.atLineStart = true;
      await runOnce(trimmed);
    }
  } finally {
    session.dispose();
  }
  return { exitCode: EXIT_OK, replies, toolCalls, notes };
}

