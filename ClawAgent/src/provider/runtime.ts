// The seam between ClawAgent and the shared LLM runtime.
//
// Everything below this module is `@openclaw/ai`: the protocol adapters, retries,
// and event stream. Everything above it is terminal I/O and config. Keeping the
// seam this thin means a provider fix upstream is picked up by a `git pull`, and
// means the chat command can be tested with a fake runtime and no network.
//
// The runtime is created lazily and once: `registerBuiltInApiProviders` imports
// every vendor SDK, which is real startup cost on a phone, and paying it for
// `clawagent doctor` would be a waste.

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  CompleteSimpleFn,
  Message,
  Model,
  StreamFn,
  ProviderStreamOptions,
  UserMessage,
} from "@openclaw/llm-core";
// NOTE: `ProviderStreamOptions` must come from llm-core, not `@openclaw/ai`.
// Both packages export a type with that name and they are not interchangeable:
// llm-core's is `StreamOptions & Record<string, unknown>` and is what
// `createLlmRuntime().stream` accepts, while ai's intersects a `unique symbol`
// key instead. Importing ai's produces two structurally different types and
// fails at the seam with a misleading "index signature is missing" error.

/** The part of the shared runtime this module needs. Narrow enough to fake. */
export type ChatRuntime = {
  stream(
    model: Model,
    context: Context,
    options?: ProviderStreamOptions,
  ): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
};

/** Read side of the shared event stream. */
export type AssistantMessageEventStream = AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

/**
 * Normalised turn events for a caller that only renders text.
 *
 * The shared protocol carries eleven event kinds; a terminal chat cares about
 * four. Collapsing them here keeps tool-call and cache plumbing out of the UI
 * until the milestone that needs it.
 */
export type ChatTurnEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "complete"; message: AssistantMessage }
  | { type: "failed"; error: string };

/**
 * The full runtime, including the "simple" surface `@openclaw/agent-core` drives.
 *
 * `ChatRuntime` above is what a text-only turn needs. The agent loop is written
 * against `streamSimple` (it owns tool schemas, steering, and retries itself), so
 * the same cached object is exposed under a wider type rather than built twice:
 * two runtimes in one process means two vendor SDK clients and two connection
 * pools, and on a phone that is battery and sockets for nothing.
 *
 * The two extra members are optional because an injected runtime is a legitimate
 * narrow one: a `chat` test fake that implements `stream` alone is asserting that
 * chat needs nothing more, and that assertion is worth keeping. `createAgentSession`
 * therefore checks for `streamSimple` and says so, instead of the type system
 * forcing every fake in the repository to grow a method it never calls.
 */
export type ModelRuntime = ChatRuntime & {
  streamSimple?: StreamFn;
  completeSimple?: CompleteSimpleFn;
};

let cachedRuntime: ModelRuntime | undefined;

/**
 * Builds the real runtime from the shared package.
 *
 * `registerBuiltInApiProviders` lives at `@openclaw/ai/providers`, which is a
 * public subpath but is deliberately not re-exported from the package index: the
 * index stays cheap for callers that only need types.
 */
export async function createChatRuntime(): Promise<ModelRuntime> {
  if (cachedRuntime) {
    return cachedRuntime;
  }
  const [{ createApiRegistry, createLlmRuntime }, { registerBuiltInApiProviders }] =
    await Promise.all([import("@openclaw/ai"), import("@openclaw/ai/providers")]);
  const registry = createApiRegistry();
  registerBuiltInApiProviders(registry);
  const runtime = createLlmRuntime(registry);
  // Destructured methods are re-bound here on purpose: the shared runtime's
  // methods rely on `this`, and `const { stream } = runtime` would drop it.
  const { stream, streamSimple, completeSimple } = runtime;
  cachedRuntime = {
    stream: (model, context, options) => stream(model, context, options),
    streamSimple: (model, context, options) => streamSimple(model, context, options),
    completeSimple: (model, context, options) => completeSimple(model, context, options),
  };
  return cachedRuntime;
}

/** Drops the memoised runtime. Used by tests and by a future `runtime reset`. */
export function resetChatRuntime(): void {
  cachedRuntime = undefined;
}

function textOf(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  return undefined;
}

/** Concatenates the text blocks of an assistant message. */
export function extractText(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((entry) => textOf(entry) ?? "")
    .join("")
    .trimEnd();
}

/** Error text from a failed assistant message, falling back to a generic line. */
export function extractError(message: AssistantMessage | undefined): string {
  const candidate = message as (Record<string, unknown> & AssistantMessage) | undefined;
  const errorMessage = candidate?.errorMessage;
  if (typeof errorMessage === "string" && errorMessage.trim()) {
    return errorMessage.trim();
  }
  const stopReason = candidate?.stopReason;
  if (typeof stopReason === "string" && stopReason.trim()) {
    return `stream ended with stopReason "${stopReason}"`;
  }
  return "the stream ended without a usable reply";
}

/** Builds a user turn. */
export function userMessage(text: string, timestamp = Date.now()): UserMessage {
  return { role: "user", content: text, timestamp };
}

export type BuildContextParams = {
  systemPrompt?: string;
  /** Turns already exchanged, oldest first. */
  messages?: readonly Message[];
  /**
   * New user input to append. Omit it when `messages` already ends with the
   * current user turn — appending twice would send the same prompt to the
   * provider twice.
   */
  input?: string;
  timestamp?: number;
};

/**
 * Assembles a `Context` for one turn.
 *
 * The system prompt goes in `Context.systemPrompt` rather than as a message: the
 * adapters map it to each vendor's native system field, which is what makes
 * prompt caching work. Handing it over as a `system` role message would push that
 * decision onto every provider.
 */
export function buildContext(params: BuildContextParams): Context {
  const messages: Message[] = [...(params.messages ?? [])];
  if (params.input !== undefined) {
    messages.push(userMessage(params.input, params.timestamp));
  }
  const systemPrompt = params.systemPrompt?.trim();
  return { ...(systemPrompt ? { systemPrompt } : {}), messages };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Streams one turn, yielding normalised events.
 *
 * Nothing throws out of this generator. `createLlmRuntime` throws synchronously
 * when no adapter is registered for `model.api`, and adapters can reject mid
 * stream; both become a `failed` event, because a chat loop that crashes loses
 * the user's typed input along with it.
 */
export async function* runChatTurn(params: {
  runtime: ChatRuntime;
  model: Model;
  context: Context;
  options?: ProviderStreamOptions;
}): AsyncGenerator<ChatTurnEvent> {
  let stream: AssistantMessageEventStream;
  try {
    stream = await params.runtime.stream(params.model, params.context, params.options);
  } catch (error) {
    yield { type: "failed", error: describeError(error) };
    return;
  }

  try {
    for await (const event of stream) {
      switch (event.type) {
        case "text_delta": {
          if (event.delta) {
            yield { type: "text", delta: event.delta };
          }
          break;
        }
        case "thinking_delta": {
          if (event.delta) {
            yield { type: "thinking", delta: event.delta };
          }
          break;
        }
        case "done": {
          yield { type: "complete", message: event.message };
          return;
        }
        case "error": {
          yield { type: "failed", error: extractError(event.error) };
          return;
        }
        default: {
          // start/text_start/text_end/toolcall_*/thinking_start/thinking_end are
          // either checkpoints or belong to a later milestone.
          break;
        }
      }
    }
    // The iterable ended without a terminal event: treat it as a failure rather
    // than reporting a truncated reply as complete.
    yield { type: "failed", error: "the stream ended without a terminal event" };
  } catch (error) {
    yield { type: "failed", error: describeError(error) };
  }
}
