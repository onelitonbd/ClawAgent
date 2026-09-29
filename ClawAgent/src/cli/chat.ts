// `clawagent chat` — the interactive terminal conversation.
//
// Two modes share one code path:
//   interactive  — a readline loop, streaming tokens as they arrive
//   one-shot     — `chat -m "..."`, prints the reply and exits
//
// One-shot mode is not a convenience feature. It is how a chat turn gets tested
// without a TTY, how a shell script uses ClawAgent, and the difference between
// "works on my laptop" and "works in Termux where stdin may be a pipe".
//
// A failed turn prints an error and keeps the loop alive. Losing a conversation
// because one request hit a 502 is the worst possible behaviour on a mobile
// connection, which is where this is expected to run.

import readline from "node:readline";
import type { AssistantMessage, Message, Model, ProviderStreamOptions } from "@openclaw/llm-core";
import { resolveConfig, type ResolvedConfig } from "../config/config.ts";
import type { ClawAgentPaths } from "../config/paths.ts";
import { describeApiKey, resolveApiKey } from "../credentials/api-key.ts";
import { explainTurnError, renderTurnError } from "../provider/errors.ts";
import { describeModel, resolveModel } from "../provider/model.ts";
import {
  buildContext,
  createChatRuntime,
  extractText,
  runChatTurn,
  type ChatRuntime,
  type ModelRuntime,
} from "../provider/runtime.ts";
import { EXIT_CONFIG, EXIT_OK, EXIT_PROVIDER, EXIT_USAGE } from "./exit-codes.ts";
import { isTTY, writeLines as writeLinesTo, type OutputStream } from "./streams.ts";
import type { CommandSpec } from "./argv.ts";

/** Minimal input abstraction, so the loop is testable without a TTY. */
export type ChatPrompter = {
  /** Resolves with the next line, or `undefined` at end of input. */
  next(): Promise<string | undefined>;
  /** Registers the interrupt handler; the last registration wins. */
  onInterrupt(handler: () => void): void;
  close(): void;
};

export type ChatOptions = {
  env?: NodeJS.ProcessEnv;
  paths?: ClawAgentPaths;
  stdout?: OutputStream;
  stderr?: OutputStream;
  /** Pre-resolved config; otherwise read from `paths.configFile` plus env. */
  config?: ResolvedConfig;
  /** Injected runtime factory; tests supply a fake so no network is touched. */
  runtimeFactory?: () => Promise<ModelRuntime>;
  /** Injected prompter; interactive mode requires one. */
  prompter?: ChatPrompter;
  /** One-shot input. When set, exactly one turn runs and no prompter is needed. */
  message?: string;
  /** Overrides everything, including config. What `--system` sets. */
  systemPrompt?: string;
  /**
   * Fallback when neither a flag nor config supplies a prompt. `chat` leaves it
   * alone; `agent` passes its tool-use prompt. Without this field the two
   * commands could not share one startup, because a command-specific default
   * written into `systemPrompt` outranks `CLAWAGENT_SYSTEM_PROMPT` and would
   * silently win over the user's own setting.
   */
  defaultSystemPrompt?: string;
  showThinking?: boolean;
  /** Prompt string for interactive mode. */
  prompt?: string;
};

export type ChatResult = {
  exitCode: number;
  /** Assistant text produced, one entry per completed turn. */
  replies: string[];
};

/** `chat` as the parser and usage text see it. */
export const CHAT_COMMAND: CommandSpec = {
  name: "chat",
  description: "Talk to a model in the terminal",
  args: [],
  flags: [
    {
      name: "message",
      alias: "m",
      type: "string",
      value: "<text>",
      description: "Send one message, print the reply, and exit",
    },
    {
      name: "model",
      type: "string",
      value: "<id>",
      description: "Model id for this run, overriding config",
    },
    {
      name: "provider",
      type: "string",
      value: "<id>",
      description: "Provider preset for this run, overriding config",
    },
    {
      name: "base-url",
      type: "string",
      value: "<url>",
      description: "Endpoint for this run; needed for a custom provider",
    },
    {
      name: "api",
      type: "string",
      value: "<adapter>",
      description: "Protocol adapter, e.g. openai-completions",
    },
    {
      name: "max-tokens",
      type: "string",
      value: "<n>",
      description: "Output token cap for this run",
    },
    {
      name: "system",
      alias: "s",
      type: "string",
      value: "<text>",
      description: "System prompt for this run",
    },
    {
      name: "show-thinking",
      type: "boolean",
      description: "Print reasoning deltas as they stream",
    },
  ],
};

/** Flag names that override the model descriptor, mapped to config keys. */
const MODEL_FLAG_KEYS = {
  model: "id",
  provider: "provider",
  "base-url": "baseUrl",
  api: "api",
} as const;

/**
 * Layers model flags over resolved config.
 *
 * Named for what it merges rather than for a command: `chat` and `agent` accept
 * the same `--model/--provider/--base-url/--api/--max-tokens/--system` set, and a
 * second copy of this precedence chain is how one command ends up accepting a
 * flag the other silently ignores.
 *
 * Precedence ends up flag > environment > file, which is what a one-off run
 * needs: `chat --model haiku -m "hi"` should not require editing anything.
 */
export function mergeModelFlagOverrides(
  resolved: ResolvedConfig,
  flags: Record<string, string | boolean>,
): ResolvedConfig {
  const model: Record<string, unknown> = { ...(resolved.config.model ?? {}) };
  const chat: Record<string, unknown> = { ...(resolved.config.chat ?? {}) };
  const problems = [...resolved.problems];

  for (const [flag, key] of Object.entries(MODEL_FLAG_KEYS)) {
    const value = flags[flag];
    if (typeof value === "string" && value.trim()) {
      model[key] = value.trim();
    }
  }
  const maxTokens = flags["max-tokens"];
  if (typeof maxTokens === "string" && maxTokens.trim()) {
    const number = Number(maxTokens);
    if (Number.isFinite(number) && number > 0) {
      model.maxTokens = Math.floor(number);
      chat.maxTokens = Math.floor(number);
    } else {
      problems.push("--max-tokens must be a positive number");
    }
  }
  const system = flags.system;
  if (typeof system === "string" && system.trim()) {
    chat.systemPrompt = system.trim();
  }

  return {
    config: {
      ...(Object.keys(model).length > 0 ? { model: model as ResolvedConfig["config"]["model"] } : {}),
      ...(Object.keys(chat).length > 0 ? { chat: chat as ResolvedConfig["config"]["chat"] } : {}),
    },
    file: resolved.file,
    problems,
  };
}

/** Slash commands understood inside the interactive loop. */
export const CHAT_COMMANDS: readonly { name: string; description: string }[] = [
  { name: "/help", description: "show these commands" },
  { name: "/model", description: "show the model in use" },
  { name: "/system", description: "show the system prompt, or set it: /system <text>" },
  { name: "/clear", description: "forget the conversation so far" },
  { name: "/exit", description: "leave the chat (also /quit, or Ctrl-D)" },
];

const DEFAULT_SYSTEM_PROMPT =
  "You are ClawAgent, a concise assistant running on the user's own device.";

/**
 * Creates a prompter over readline.
 *
 * Lines are queued rather than requested one at a time with `interface.question`.
 * That distinction is the whole reason this function exists: when stdin is a pipe,
 * readline emits every buffered line as soon as it arrives, so a `question()`
 * registered afterwards never hears them and the loop hangs at end of input with
 * an unsettled await. `clawagent chat < prompts.txt` and any script driving chat
 * both take that path, so it has to work.
 *
 * The prompt is only written for a terminal. On a pipe it would be interleaved
 * into the transcript as noise.
 */
export function createReadlinePrompter(params: {
  input: NodeJS.ReadStream;
  output: OutputStream;
  prompt: string;
}): ChatPrompter {
  const terminal = isTTY(params.output);
  const interface_ = readline.createInterface({
    input: params.input,
    output: params.output as NodeJS.WriteStream,
    terminal,
  });
  if (terminal) {
    interface_.setPrompt(params.prompt);
  }

  const queued: string[] = [];
  const waiters: Array<(value: string | undefined) => void> = [];
  let closed = false;
  let interruptHandler: (() => void) | undefined;

  const release = (value: string | undefined): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(value);
      return;
    }
    if (value !== undefined) {
      queued.push(value);
    }
  };

  interface_.on("line", (line) => {
    release(line);
  });

  interface_.on("close", () => {
    // End of input: wake everyone with "no more lines", now and forever after.
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()?.(undefined);
    }
  });

  if (terminal) {
    interface_.on("SIGINT", () => {
      // With no handler, readline pauses the prompt and Ctrl-C looks dead.
      if (interruptHandler) {
        interruptHandler();
        return;
      }
      interface_.close();
    });
  }

  return {
    next(): Promise<string | undefined> {
      const buffered = queued.shift();
      if (buffered !== undefined) {
        if (terminal && !closed) {
          interface_.prompt();
        }
        return Promise.resolve(buffered);
      }
      if (closed) {
        return Promise.resolve(undefined);
      }
      if (terminal) {
        interface_.prompt();
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    onInterrupt(handler: () => void): void {
      interruptHandler = handler;
    },
    close(): void {
      if (closed) {
        return;
      }
      interface_.close();
    },
  };
}

/** Command help text for the loop and for `chat --help`. */
export function renderChatCommands(): string[] {
  const width = Math.max(...CHAT_COMMANDS.map((command) => command.name.length));
  return CHAT_COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.description}`);
}

type TurnOutcome = {
  /** Assistant text, from the terminal message when the provider sent one. */
  text: string;
  /** The provider's own assistant message; undefined when the turn failed. */
  message: AssistantMessage | undefined;
  ok: boolean;
  error: string | undefined;
};

/**
 * Runs one model turn, streaming text to stdout as it arrives.
 *
 * The stored reply comes from the terminal `done` message rather than from the
 * accumulated deltas: that message is the provider's own record, so it carries
 * real usage and stop-reason fields, and it survives providers that omit
 * `partial` snapshots on text deltas.
 */
async function streamOneTurn(params: {
  runtime: ChatRuntime;
  model: Model;
  messages: readonly Message[];
  systemPrompt: string;
  options: ProviderStreamOptions;
  stdout: OutputStream;
  showThinking: boolean;
  colour: boolean;
}): Promise<TurnOutcome> {
  const { stdout, showThinking, colour } = params;
  const deltas: string[] = [];
  let thinkingOpen = false;
  let message: AssistantMessage | undefined;
  let error: string | undefined;

  const closeThinking = (): void => {
    if (thinkingOpen) {
      stdout.write(colour ? "\x1b[22m\n" : "\n");
      thinkingOpen = false;
    }
  };

  for await (const event of runChatTurn({
    runtime: params.runtime,
    model: params.model,
    // `messages` already ends with the current user turn, so no `input` here —
    // passing one would send the same prompt twice.
    context: buildContext({ systemPrompt: params.systemPrompt, messages: params.messages }),
    options: params.options,
  })) {
    if (event.type === "text") {
      deltas.push(event.delta);
      stdout.write(event.delta);
    } else if (event.type === "thinking") {
      if (showThinking) {
        if (!thinkingOpen) {
          stdout.write(colour ? "\x1b[2m" : "");
          thinkingOpen = true;
        }
        stdout.write(event.delta);
      }
    } else if (event.type === "complete") {
      message = event.message;
    } else {
      error = event.error;
    }
  }
  closeThinking();

  const streamed = deltas.join("");
  const text = (message ? extractText(message) : "") || streamed;
  if (error) {
    return { text, ...(message ? { message } : { message: undefined }), ok: false, error };
  }
  if (text) {
    stdout.write("\n");
  }
  return { text, ...(message ? { message } : { message: undefined }), ok: true, error: undefined };
}

/** Startup: config, model descriptor, credentials, runtime. */
export type ChatStartup =
  | {
      ok: true;
      model: Model;
      /**
       * The full runtime. `chat` only reads `stream`; the agent session needs
       * `streamSimple`, and both come from the one cached runtime object.
       */
      runtime: ModelRuntime;
      key: string;
      systemPrompt: string;
      options: ProviderStreamOptions;
      providerLabel: string;
    }
  | { ok: false; exitCode: number; lines: string[] };

/**
 * Resolves config, model, credentials, and runtime for a terminal session.
 *
 * Exported because `agent` needs the identical sequence. Two copies of startup is
 * how one command ends up printing a config error the other one hides.
 */
export async function startModelSession(
  options: ChatOptions,
  env: NodeJS.ProcessEnv,
  stderr: OutputStream,
): Promise<ChatStartup> {
  const resolved = options.config ?? resolveConfig(options.paths, env);
  // Reported the moment they are known. These were originally flushed only after
  // the runtime started, which meant the two early returns below exited without
  // ever printing the reason — the user saw "run clawagent doctor" and nothing
  // explaining what was actually wrong.
  for (const problem of resolved.problems) {
    stderr.write(`config: ${problem}\n`);
  }

  const modelResult = resolveModel(resolved.config.model ?? {});
  if (!modelResult.ok) {
    return {
      ok: false,
      exitCode: EXIT_CONFIG,
      lines: [
        `error: ${modelResult.error}`,
        ...(modelResult.hint ? [`       ${modelResult.hint}`] : []),
        "",
        `set a model in ${resolved.file ?? "clawagent.json"}, or:`,
        "  CLAWAGENT_PROVIDER=anthropic CLAWAGENT_MODEL=claude-sonnet-4-5 clawagent chat",
      ],
    };
  }

  const { model, preset, apiKeyEnvVars } = modelResult.value;
  const key = resolveApiKey({
    provider: model.provider,
    envVars: apiKeyEnvVars,
    env,
    ...(options.paths?.credentialsDir ? { credentialsDir: options.paths.credentialsDir } : {}),
    modelId: model.id,
  });
  for (const problem of key.problems) {
    stderr.write(`credentials: ${problem}\n`);
  }
  if (!key.key) {
    return {
      ok: false,
      exitCode: EXIT_CONFIG,
      lines: ["", "run `clawagent doctor` to see what this device supports."],
    };
  }

  let runtime: ChatRuntime;
  try {
    runtime = options.runtimeFactory ? await options.runtimeFactory() : await createChatRuntime();
  } catch (error) {
    return {
      ok: false,
      exitCode: EXIT_PROVIDER,
      lines: [
        `error: could not start the model runtime: ${error instanceof Error ? error.message : String(error)}`,
        "",
        "the provider adapters load their vendor SDKs at startup; if a package is",
        "missing, reinstall dependencies with: npm install --omit=dev",
      ],
    };
  }

  const chatSettings = resolved.config.chat ?? {};
  const systemPrompt =
    options.systemPrompt?.trim() ||
    chatSettings.systemPrompt?.trim() ||
    options.defaultSystemPrompt?.trim() ||
    DEFAULT_SYSTEM_PROMPT;
  const streamOptions: ProviderStreamOptions = {
    apiKey: key.key,
    ...(chatSettings.temperature === undefined ? {} : { temperature: chatSettings.temperature }),
    ...(chatSettings.maxTokens === undefined ? {} : { maxTokens: chatSettings.maxTokens }),
  };

  return {
    ok: true,
    model,
    runtime,
    key: key.key,
    systemPrompt,
    options: streamOptions,
    providerLabel: preset ? preset.label : model.provider,
  };
}

/** Runs the chat command. */
export async function runChat(options: ChatOptions = {}): Promise<ChatResult> {
  const env = options.env ?? process.env;
  const stdout: OutputStream = options.stdout ?? process.stdout;
  const stderr: OutputStream = options.stderr ?? process.stderr;
  const replies: string[] = [];
  const colour = isTTY(stdout) && !env.NO_COLOR;
  const writeLines = writeLinesTo;

  const oneShot = options.message !== undefined;
  const prompter = options.prompter;
  if (!oneShot && !prompter) {
    writeLines(stderr, [
      "error: interactive chat needs a terminal prompter",
      '       pass -m "..." for one-shot use, or run from a TTY',
    ]);
    return { exitCode: EXIT_USAGE, replies };
  }
  if (oneShot && !options.message?.trim()) {
    writeLines(stderr, ["error: -m needs a non-empty message"]);
    return { exitCode: EXIT_USAGE, replies };
  }

  const startup = await startModelSession(options, env, stderr);
  if (!startup.ok) {
    writeLines(stderr, startup.lines);
    return { exitCode: startup.exitCode, replies };
  }

  const { model, runtime, systemPrompt: initialPrompt, options: streamOptions } = startup;
  let systemPrompt = initialPrompt;
  const messages: Message[] = [];

  /** One turn: append the user message, stream, then record the assistant reply. */
  const runTurn = async (input: string, signal: AbortSignal): Promise<TurnOutcome> => {
    messages.push({ role: "user", content: input, timestamp: Date.now() });
    const outcome = await streamOneTurn({
      runtime,
      model,
      messages,
      systemPrompt,
      options: { ...streamOptions, signal },
      stdout,
      showThinking: options.showThinking === true,
      colour,
    });
    if (outcome.ok && outcome.message) {
      // The provider's own message goes into history, so usage and stop reason
      // stay accurate instead of being reconstructed here.
      messages.push(outcome.message);
      replies.push(outcome.text);
    } else {
      // Drop the user message too: a turn that produced nothing was never seen
      // by the model, and leaving it would desynchronise the next request.
      messages.pop();
    }
    return outcome;
  };

  if (oneShot) {
    const outcome = await runTurn(options.message ?? "", new AbortController().signal);
    if (!outcome.ok) {
      // Without this a failed one-shot run exits non-zero and prints nothing at
      // all, which in a script looks like the command never ran.
      writeLines(stderr, renderTurnError(explainTurnError(outcome.error ?? "", model)));
    }
    return { exitCode: outcome.ok ? EXIT_OK : EXIT_PROVIDER, replies };
  }

  writeLines(stdout, [
    `ClawAgent chat — ${describeModel(model)}`,
    `key ${describeApiKey({ key: startup.key, source: "provider-env", problems: [] })}  ·  ${startup.providerLabel}`,
    "/help for commands, Ctrl-D to leave",
    "",
  ]);

  const loop = prompter as ChatPrompter;
  let controller = new AbortController();
  let interrupted = false;
  loop.onInterrupt(() => {
    interrupted = true;
    controller.abort();
  });

  for (;;) {
    const line = await loop.next();
    if (line === undefined) {
      break;
    }
    const input = line.trim();
    if (interrupted) {
      interrupted = false;
      controller = new AbortController();
      writeLines(stdout, ["", "(interrupted)"]);
      continue;
    }
    if (!input) {
      continue;
    }

    if (input.startsWith("/")) {
      const parts = input.split(/\s+/u);
      const name = (parts[0] ?? "").toLowerCase();
      const argument = parts.slice(1).join(" ");
      if (name === "/exit" || name === "/quit" || name === "/q") {
        break;
      }
      if (name === "/help" || name === "/?") {
        writeLines(stdout, renderChatCommands());
      } else if (name === "/model") {
        writeLines(stdout, [
          describeModel(model),
          `baseUrl ${model.baseUrl}`,
          `maxTokens ${model.maxTokens}  reasoning ${model.reasoning ? "on" : "off"}`,
        ]);
      } else if (name === "/system") {
        if (argument) {
          systemPrompt = argument;
          writeLines(stdout, [`system prompt set (${argument.length} characters)`]);
        } else {
          writeLines(stdout, [systemPrompt]);
        }
      } else if (name === "/clear") {
        messages.length = 0;
        writeLines(stdout, ["conversation cleared"]);
      } else {
        writeLines(stdout, [`unknown command ${name}`, ...renderChatCommands()]);
      }
      continue;
    }

    const outcome = await runTurn(input, controller.signal);
    if (!outcome.ok) {
      writeLines(stderr, [
        ...renderTurnError(explainTurnError(outcome.error ?? "", model)),
        "(the conversation is unchanged — try again)",
      ]);
    }
    controller = new AbortController();
  }

  loop.close();
  return { exitCode: EXIT_OK, replies };
}
