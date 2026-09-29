// The agent session: an `@openclaw/agent-core` loop, this workspace's tools, and
// the approval gate, wired together.
//
// WHY THE LOOP COMES FROM THE SHARED CORE
//
// The loop is the part that is easiest to sketch and hardest to get right: async
// tool batches that must be durable before side effects, steering input that can
// only be injected at specific points, a provider stream that ends without a
// terminal event, an output-limit error that is recoverable *only* if already
// admitted tools are drained. That is `agent-core`'s code, already exercised by
// the desktop host. Reimplementing even a tenth of it here would be the largest
// source of behavioural drift this rebuild could introduce.
//
// WHAT THIS FILE OWNS
//
// Composition, plus one decision worth stating: the session is created once per
// process and the `Agent` instance is kept between turns, so a multi-turn run has
// one transcript, one steering queue, and one provider session id. A fresh `Agent`
// per turn looks identical for the first message and is wrong from the second on.

import path from "node:path";
import type { CompleteSimpleFn, Model, ProviderStreamOptions, StreamFn } from "@openclaw/llm-core";
import type { AgentTool } from "@openclaw/agent-core";
import type { ApprovalGate, ApprovalInput, ApprovalWriter } from "../approvals/gate.ts";
import { createApprovalGate } from "../approvals/gate.ts";
import type { ApprovalMode } from "../approvals/policy.ts";
import type { ModelRuntime } from "../provider/runtime.ts";
import { explainTurnError } from "../provider/errors.ts";
import type { BuildToolOptions } from "../tools/index.ts";
// `buildWorkspaceTools` is imported where it is used, inside the async
// `createAgentSession` below. Statically, the tool layer drags `typebox` and
// `@openclaw/agent-core` into the CLI's module scope, which makes
// `clawagent version`, `clawagent doctor`, and even `clawagent help` die with
// ERR_MODULE_NOT_FOUND on a checkout that has not run `npm install` yet — the
// exact device state `doctor` exists to diagnose.

/** System prompt for tool runs. Kept here so a test can assert on it. */
export const AGENT_SYSTEM_PROMPT = [
  "You are ClawAgent, an assistant running in a terminal on the user's Android",
  "device (Termux). You can read and write files and run programs in the current",
  "workspace.",
  "",
  "Working rules:",
  "- Paths are relative to the workspace root. Read before you edit.",
  "- Prefer `edit` with exact text over rewriting a whole file with `write`.",
  "- `bash` runs one program with arguments and no shell: no pipes, redirection,",
  "  `;`, or command substitution. Chain steps as separate calls.",
  "- Long output is capped. Use `grep`, or `read` with `offset`, instead of",
  "  dumping a whole file.",
  "- If a tool call is refused, do not retry it unchanged. Explain, or adjust.",
  "- Keep going until the task is done, then say what changed in a few lines.",
].join("\n");

export type AgentTurnEvent =
  | { type: "assistant-text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool-start"; toolName: string; args: unknown }
  | { type: "tool-end"; toolName: string; ok: boolean }
  | { type: "turn-end"; text: string; toolCalls: number }
  | { type: "failed"; error: string };

export type AgentSessionOptions = {
  model: Model;
  runtime: ModelRuntime;
  apiKey: string;
  systemPrompt?: string;
  mode: ApprovalMode;
  tools?: BuildToolOptions;
  input: ApprovalInput;
  output: ApprovalWriter;
  colour?: boolean;
  streamOptions?: ProviderStreamOptions;
  /**
   * Provider turns allowed per user message before the run is stopped.
   *
   * `agent-core` has no cap of its own — a loop that keeps calling tools is
   * correct as far as it is concerned. On a phone an uncapped loop is a drained
   * battery and an API bill, so the limit belongs to the host that pays for it.
   */
  maxTurns?: number;
  /** Extra or substitute tools, for tests and for later milestones. */
  extraTools?: readonly AgentTool[];
  onEvent?: (event: AgentTurnEvent) => void;
};

export type AgentTurnResult = {
  ok: boolean;
  text: string;
  toolCalls: number;
  /** Set when the provider failed; already classified for the terminal. */
  error?: string;
  errorHint?: string;
  /**
   * What the failure is, from `src/provider/errors.ts`. Kept as a field rather
   * than only folded into the text, because the retry decision belongs to the
   * caller: a network error on a phone is worth another turn, an auth error is
   * not.
   */
  errorKind?: string;
  /** Set when the turn cap stopped a run that had not finished. */
  stoppedReason?: string;
};

export type AgentSession = {
  tools: readonly AgentTool[];
  gate: ApprovalGate;
  workspaceRoot: string;
  prompt(text: string, signal?: AbortSignal): Promise<AgentTurnResult>;
  transcriptSize(): number;
  /** Detaches the event subscriber. Call when the session is finished with. */
  dispose(): void;
};

/**
 * Shape of the loop events this file renders.
 *
 * Deliberately wider than `AgentEvent`: a discriminated union would have to be
 * restated here and would drift the first time the core adds an event. Assigning
 * the real event to this is allowed, and every field read is optional, so a
 * missing one degrades a line of output rather than throwing mid-turn.
 */
type AgentEventLike = {
  type?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  assistantMessageEvent?: unknown;
};

/** The subset of the loop's tool-call context the approval gate needs. */
type ToolGateContext = {
  assistantMessage: unknown;
  toolCall: { name: string };
  args: unknown;
  context: unknown;
};

/** Minimal view of the shared `Agent`, so this file has one cast instead of three. */
type SharedAgent = {
  state: { messages: readonly unknown[]; errorMessage?: string };
  subscribe(listener: (event: AgentEventLike) => Promise<void> | void): () => void;
  prompt(input: string): Promise<void>;
  abort(reason?: unknown): void;
};

/**
 * Builds one agent session.
 *
 * `@openclaw/agent-core` and the tool layer are imported dynamically rather than
 * statically. The core reaches markdown-core and the mdast parsers through
 * `@openclaw/ai/transports`, and the tools import `typebox`; both are real parse
 * cost on a phone, and `agent --help` should not pay it. Statically they also make
 * `clawagent version` fail on a checkout that has not installed anything yet.
 */
/**
 * The tool-building options for a run in `mode`.
 *
 * `read-only` takes the mutating tools away entirely rather than leaving them
 * present for the gate to refuse: a tool the model can see but not use is a turn
 * spent calling something that cannot work, and the resulting error teaches it
 * nothing about what this run is for.
 *
 * Both the session and the plan `agent --dry-run` prints go through here, so the
 * flag cannot show a tool set that the run it describes would not have had. The
 * combination is monotone on purpose: a mode or an explicit request can drop
 * tools, and neither can put back what the other removed.
 */
export function toolOptionsForMode(
  mode: ApprovalMode,
  options: BuildToolOptions = {},
): BuildToolOptions {
  return { ...options, readOnly: mode === "read-only" || options.readOnly === true };
}

export async function createAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
  const [{ Agent }, { stripPlainTextToolCallBlocks }, { buildWorkspaceTools }] =
    await Promise.all([
      import("@openclaw/agent-core"),
      import("@openclaw/tool-call-repair"),
      import("../tools/index.ts"),
    ]);
  const built = buildWorkspaceTools(toolOptionsForMode(options.mode, options.tools));
  const tools: AgentTool[] = [...built.tools, ...(options.extraTools ?? [])];
  const gate = createApprovalGate({
    mode: options.mode,
    workspace: built.workspace,
    input: options.input,
    output: options.output,
    ...(options.colour === undefined ? {} : { colour: options.colour }),
  });
  const systemPrompt = options.systemPrompt?.trim() || AGENT_SYSTEM_PROMPT;
  // Checked rather than assumed: `ModelRuntime`'s extra members are optional so a
  // narrow fake stays legal, and a loop configured with `streamSimple: undefined`
  // would fail deep inside the core with an error that names neither this file nor
  // the mistake.
  const streamSimple = options.runtime.streamSimple;
  if (!streamSimple) {
    throw new TypeError(
      "the agent session needs a runtime that provides streamSimple; this one only provides stream",
    );
  }
  const emit = (event: AgentTurnEvent): void => {
    options.onEvent?.(event);
  };

  // Accumulated per turn for the fallback text. It is kept here rather than in
  // `prompt()` so the subscriber below stays the only writer.
  let streamed: string[] = [];
  let toolCalls = 0;
  let turns = 0;
  let capped = false;
  const maxTurns = options.maxTurns ?? Number.POSITIVE_INFINITY;

  const agent: SharedAgent = new Agent({
    initialState: {
      systemPrompt,
      model: options.model,
      tools,
      messages: [],
    },
    // The loop drives `streamSimple`. `runStream` is deliberately not provided:
    // ClawAgent owns the whole stream and has no host-side decoration to keep
    // alive across iteration.
    runtime: { streamSimple },
    getApiKey: async () => options.apiKey,
    beforeToolCall: (context: ToolGateContext, signal?: AbortSignal) =>
      gate.beforeToolCall(
        {
          assistantMessage: context.assistantMessage,
          toolCall: context.toolCall,
          args: context.args,
          context: context.context,
        },
        signal,
      ),
    // The turn cap, enforced gracefully. `terminate` on a tool result is the
    // loop's own "stop after this batch" signal, and it is what the cap uses
    // instead of `agent.abort()`: abort is a cancellation, so it lands in the
    // transcript as an aborted turn, and a user who ran to the limit would be
    // told the model failed when in fact it did exactly what it was asked up to
    // the ceiling the host set.
    afterToolCall: async () => {
      if (turns + 1 < maxTurns) {
        return undefined;
      }
      capped = true;
      return { terminate: true };
    },
    // Sequential is the safe default on a phone: parallel tools interleave their
    // approval prompts, and two prompts at once is a question nobody answers
    // correctly.
    toolExecution: "sequential",
    // Cache-aware providers key on it; a stable id per session keeps prompts warm.
    sessionId: `clawagent-${path.basename(built.workspace.root)}`,
    ...(options.streamOptions?.temperature === undefined
      ? {}
      : { temperature: options.streamOptions.temperature }),
  }) as unknown as SharedAgent;

  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent as
        | { type?: string; delta?: string }
        | undefined;
      if (inner?.type === "text_delta" && typeof inner.delta === "string") {
        streamed.push(inner.delta);
        emit({ type: "assistant-text", delta: inner.delta });
      } else if (inner?.type === "thinking_delta" && typeof inner.delta === "string") {
        emit({ type: "thinking", delta: inner.delta });
      }
      return;
    }
    if (event.type === "turn_end") {
      turns += 1;
      return;
    }
    if (event.type === "tool_execution_start") {
      toolCalls += 1;
      emit({ type: "tool-start", toolName: String(event.toolName), args: event.args });
      return;
    }
    if (event.type === "tool_execution_end") {
      emit({
        type: "tool-end",
        toolName: String(event.toolName),
        ok: event.isError !== true,
      });
    }
  });

  const finish = (message: unknown): string =>
    stripPlainTextToolCallBlocks(textOf(message)) || streamed.join("");

  return {
    tools,
    gate,
    workspaceRoot: built.workspace.root,
    transcriptSize: () => agent.state.messages.length,
    dispose: () => {
      unsubscribe();
    },
    async prompt(text: string, signal?: AbortSignal): Promise<AgentTurnResult> {
      streamed = [];
      turns = 0;
      capped = false;
      const before = toolCalls;
      try {
        await (signal ? withAbort(agent, text, signal) : agent.prompt(text));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const explained = explainTurnError(message, options.model);
        emit({ type: "failed", error: explained.message });
        return {
          ok: false,
          text: "",
          toolCalls,
          error: explained.message,
          errorKind: explained.kind,
          ...(explained.hint ? { errorHint: explained.hint } : {}),
        };
      }
      const last = lastAssistant(agent);
      const errorMessage =
        agent.state.errorMessage ||
        (last?.stopReason === "error" ? last.errorMessage || "the model turn failed" : undefined);
      if (errorMessage) {
        const explained = explainTurnError(stripPlainTextToolCallBlocks(errorMessage), options.model);
        emit({ type: "failed", error: explained.message });
        return {
          ok: false,
          text: "",
          toolCalls,
          error: explained.message,
          errorKind: explained.kind,
          ...(explained.hint ? { errorHint: explained.hint } : {}),
        };
      }
      const body = finish(last);
      emit({ type: "turn-end", text: body, toolCalls });
      return {
        ok: true,
        text: body,
        toolCalls: toolCalls - before,
        ...(capped ? { stoppedReason: `stopped after ${turns} turns (--max-turns)` } : {}),
      };
    },
  };
}

type AssistantLike = { stopReason?: string; errorMessage?: string; content?: unknown };

function lastAssistant(agent: SharedAgent): AssistantLike | undefined {
  const messages = agent.state.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index] as { role?: string } | undefined;
    if (candidate?.role === "assistant") {
      return candidate as AssistantLike;
    }
  }
  return undefined;
}

function textOf(message: unknown): string {
  if (message === undefined || message === null || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) =>
      typeof part === "object" && part !== null && (part as { type?: string }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/**
 * Runs a prompt under an external abort signal.
 *
 * `Agent.abort()` is the loop's own cancellation and is what actually stops tool
 * execution, so Ctrl-C has to reach it rather than only rejecting the local
 * promise: a rejected promise with a live loop behind it keeps running tools.
 */
async function withAbort(
  agent: { prompt(text: string): Promise<void>; abort(reason?: unknown): void },
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const onAbort = (): void => {
    agent.abort(new Error("interrupted by user"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await agent.prompt(text);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
