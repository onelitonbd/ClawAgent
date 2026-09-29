// Shared fixtures for the M1 chat tests.
//
// Lives under `test/` so the boundary rules treat it as test-only. Everything
// here exists to let the chat path be exercised without a network, a TTY, or a
// vendor SDK: a fake runtime that replays a scripted event sequence, a prompter
// that replays typed lines, and a sink that captures what was written.
//
// The fixtures build real `@openclaw/llm-core` values rather than loose objects,
// because the point of the tests is that ClawAgent honours that contract.

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderStreamOptions,
  Usage,
} from "@openclaw/llm-core";
import type { ChatPrompter } from "../src/cli/chat.ts";
import type { ModelRuntime } from "../src/provider/runtime.ts";
import type { OutputStream } from "../src/cli/streams.ts";

/** A complete `Usage` record; every field is required by the contract. */
export function fakeUsage(input = 10, output = 20): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function assistantMessage(
  text: string,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: fakeUsage(),
    stopReason: "stop",
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * An assistant message whose only content is a tool call.
 *
 * `stopReason: "toolUse"` is what makes the agent loop execute it; a tool call in
 * a message that stopped otherwise is a shape no provider emits.
 */
export function toolCallMessage(
  name: string,
  args: Record<string, unknown>,
  toolCallId = `call-${Math.random().toString(36).slice(2, 8)}`,
): AssistantMessage {
  return {
    ...assistantMessage(""),
    content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
    stopReason: "toolUse",
  };
}

/** Events for a reply that carries pre-made content, so tool calls can be scripted. */
export function messageEvents(message: AssistantMessage): AssistantMessageEvent[] {
  return [
    { type: "start", partial: message },
    { type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message },
  ];
}

export function fakeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "claude-test",
    name: "Claude Test",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 1024,
    ...overrides,
  };
}

/** What a fake runtime records about the call it received. */
export type RecordedCall = {
  model: Model;
  context: Context;
  options: ProviderStreamOptions | undefined;
};

export type FakeRuntime = ModelRuntime & {
  calls: RecordedCall[];
};

/**
 * Builds a runtime that replays `events` for every call.
 *
 * Supplying a function instead of an array lets a test vary the reply per turn,
 * which is how a multi-turn conversation is checked.
 */
export function fakeRuntime(
  script: AssistantMessageEvent[] | ((call: RecordedCall) => AssistantMessageEvent[]),
): FakeRuntime {
  const calls: RecordedCall[] = [];
  const eventsFor = (
    model: Model,
    context: Context,
    options: ProviderStreamOptions | undefined,
  ): {
    [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>;
    result(): Promise<AssistantMessage>;
  } => {
    const call: RecordedCall = { model, context, options };
    calls.push(call);
    const events = typeof script === "function" ? script(call) : script;
    let final: AssistantMessage | undefined;
    for (const event of events) {
      if (event.type === "done") {
        final = event.message;
      } else if (event.type === "error") {
        final = event.error;
      }
    }
    const resolved = final;
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
      result(): Promise<AssistantMessage> {
        return resolved
          ? Promise.resolve(resolved)
          : Promise.reject(new Error("fake stream produced no terminal message"));
      },
    };
  };
  return {
    calls,
    // `streamSimple` delegates to the same recorder: the agent loop drives the
    // "simple" surface while `chat` drives `stream`, and a fake with two
    // behaviours would hide a wiring mistake in whichever one no test used.
    async streamSimple(model, context, options) {
      return eventsFor(model as Model, context, options as ProviderStreamOptions);
    },
    async completeSimple(model, context, options) {
      return (await eventsFor(model as Model, context, options as ProviderStreamOptions)).result();
    },
    async stream(model, context, options) {
      return eventsFor(model as Model, context, options as ProviderStreamOptions);
    },
  };
}

/** The event sequence for a normal streamed reply. */
export function replyEvents(text: string): AssistantMessageEvent[] {
  const message = assistantMessage(text);
  const words = text.split(/(?<=\s)/u);
  return [
    { type: "start", partial: message },
    { type: "text_start", contentIndex: 0, partial: message },
    ...words.map((delta): AssistantMessageEvent => ({
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: message,
    })),
    { type: "text_end", contentIndex: 0, content: text, partial: message },
    { type: "done", reason: "stop", message },
  ];
}

/** The event sequence for a failed reply. */
export function failureEvents(errorMessage: string): AssistantMessageEvent[] {
  const message = assistantMessage("", { stopReason: "error", errorMessage });
  return [
    { type: "start", partial: message },
    { type: "error", reason: "error", error: message },
  ];
}

/** Captures everything written to a stream. */
export function sink(): OutputStream & { text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string): number {
      chunks.push(String(chunk));
      return String(chunk).length;
    },
    text(): string {
      return chunks.join("");
    },
  };
}

export type FakePrompter = ChatPrompter & {
  /** Simulates Ctrl-C: fires the registered interrupt handler. */
  interrupt(): void;
  /** Lines the prompter has handed out, for assertions. */
  served: string[];
};

/**
 * Replays typed lines, one per `next()` call.
 *
 * Ends input after the script runs out, which is what Ctrl-D does, so a test
 * that forgets to type `/exit` still terminates instead of hanging the suite.
 */
export function fakePrompter(lines: readonly string[]): FakePrompter {
  const queue = [...lines];
  const served: string[] = [];
  let handler: (() => void) | undefined;
  let closed = false;
  return {
    served,
    async next(): Promise<string | undefined> {
      if (closed) {
        return undefined;
      }
      const line = queue.shift();
      if (line === undefined) {
        return undefined;
      }
      served.push(line);
      return line;
    },
    onInterrupt(next: () => void): void {
      handler = next;
    },
    interrupt(): void {
      handler?.();
    },
    close(): void {
      closed = true;
    },
  };
}
