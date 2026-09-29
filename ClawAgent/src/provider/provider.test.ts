// Provider layer: presets, model descriptors, and the runtime seam.
//
// The runtime cases drive a fake, never a vendor SDK, so they run offline and in
// CI. What they are really testing is the contract ClawAgent has with
// `@openclaw/ai`: that a descriptor is built the way the adapters expect, and that
// every way a stream can end badly turns into a reported failure instead of a
// thrown exception in the middle of a conversation.

import { describe, expect, it } from "vitest";
import type { AssistantMessageEvent } from "@openclaw/llm-core";
import {
  KNOWN_APIS,
  PROVIDER_PRESETS,
  findProviderPreset,
  providerPresetIds,
} from "./presets.ts";
import { DEFAULT_MAX_TOKENS, describeModel, resolveModel } from "./model.ts";
import {
  buildContext,
  extractError,
  extractText,
  runChatTurn,
  userMessage,
} from "./runtime.ts";
import { assistantMessage, fakeModel, fakeRuntime, failureEvents, replyEvents } from "../../test/chat-support.ts";

describe("provider presets", () => {
  it("covers the adapters the shared package registers as built-ins", () => {
    // A preset naming an adapter nobody registered would fail only at request
    // time, with "No API provider registered for api".
    const presetApis = new Set(PROVIDER_PRESETS.map((preset) => preset.api));
    expect([...presetApis].sort()).toEqual([...KNOWN_APIS].sort());
  });

  it.each(PROVIDER_PRESETS.map((preset) => [preset.id, preset] as const))(
    "%s declares an adapter and at least one key variable",
    (_id, preset) => {
      expect(preset.api).toBeTruthy();
      expect(preset.apiKeyEnvVars.length).toBeGreaterThan(0);
      expect(preset.label).toBeTruthy();
    },
  );

  it("gives every vendor preset a real endpoint", () => {
    // The one preset allowed an empty baseUrl is the bring-your-own endpoint.
    const missing = PROVIDER_PRESETS.filter(
      (preset) => preset.id !== "openai-compatible" && !preset.baseUrl.startsWith("https://"),
    ).map((preset) => `${preset.id}: ${preset.baseUrl}`);
    expect(missing).toEqual([]);
  });

  it("points Google at the Generative Language endpoint", () => {
    // Regression: a transposed hostname here fails as a DNS error on device,
    // which reads like a network problem rather than a typo in a preset.
    expect(findProviderPreset("google")?.baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    );
  });

  it("looks presets up case-insensitively and ignores padding", () => {
    expect(findProviderPreset("  Anthropic ")?.id).toBe("anthropic");
  });

  it("returns undefined for an unknown provider", () => {
    expect(findProviderPreset("bedrock")).toBeUndefined();
  });

  it("lists ids in declaration order for help text", () => {
    expect(providerPresetIds()).toEqual(PROVIDER_PRESETS.map((preset) => preset.id));
  });
});

describe("resolveModel", () => {
  it("requires a model id", () => {
    const result = resolveModel({ provider: "anthropic" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no model id");
      expect(result.hint).toContain("model.id");
    }
  });

  it("suggests the nearest provider for a typo", () => {
    const result = resolveModel({ provider: "antropic", id: "claude-test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unknown provider: antropic");
      expect(result.hint).toContain('did you mean "anthropic"');
    }
  });

  it("lists the known providers when nothing is close", () => {
    const result = resolveModel({ provider: "bedrock-converse", id: "some-model" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hint).toContain("anthropic");
      expect(result.hint).not.toContain("did you mean");
    }
  });

  it("fills routing facts from the preset", () => {
    const result = resolveModel({ provider: "anthropic", id: "claude-sonnet-4-5" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.model).toMatchObject({
      id: "claude-sonnet-4-5",
      name: "claude-sonnet-4-5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    });
    expect(result.value.apiKeyEnvVars).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("lets config override the preset endpoint and adapter", () => {
    const result = resolveModel({
      provider: "anthropic",
      id: "claude-test",
      baseUrl: "https://gateway.internal/anthropic",
      api: "openai-completions",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model.baseUrl).toBe("https://gateway.internal/anthropic");
      expect(result.value.model.api).toBe("openai-completions");
    }
  });

  it("supports an arbitrary endpoint with no preset at all", () => {
    // This is the local-model path: a phone pointed at a server on the LAN.
    const result = resolveModel({
      id: "qwen-local",
      api: "openai-completions",
      baseUrl: "http://192.168.1.20:8080/v1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model.provider).toBe("custom");
      expect(result.value.preset).toBeUndefined();
      expect(result.value.apiKeyEnvVars).toEqual([]);
    }
  });

  it("refuses an endpoint it cannot determine", () => {
    const result = resolveModel({ id: "some-model", api: "openai-completions" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no baseUrl");
    }
  });

  it("refuses a model with neither preset nor adapter", () => {
    const result = resolveModel({ id: "some-model" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no protocol adapter");
    }
  });

  it("defaults the output budget and leaves pricing unpriced", () => {
    const result = resolveModel({ provider: "mistral", id: "mistral-large" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model.maxTokens).toBe(DEFAULT_MAX_TOKENS);
      // Zeros mean "not priced". A copied price table would go stale and report
      // wrong costs, so pricing stays with the desktop catalog.
      expect(result.value.model.cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(result.value.model.input).toEqual(["text"]);
      expect(result.value.model.reasoning).toBe(false);
    }
  });

  it("keeps explicit numbers and drops invalid ones", () => {
    const result = resolveModel({
      provider: "openai",
      id: "gpt-test",
      maxTokens: 2048.9,
      contextWindow: -5,
      reasoning: true,
      input: ["text", "image"],
      headers: { "X-Trace": "abc" },
      authHeader: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model.maxTokens).toBe(2048);
      expect(result.value.model.contextWindow).toBeUndefined();
      expect(result.value.model.reasoning).toBe(true);
      expect(result.value.model.input).toEqual(["text", "image"]);
      expect(result.value.model.headers).toEqual({ "X-Trace": "abc" });
      expect(result.value.model.authHeader).toBe(true);
    }
  });

  it("describes a model in one line", () => {
    const result = resolveModel({ provider: "google", id: "gemini-test" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(describeModel(result.value.model)).toBe(
        "google/gemini-test via google-generative-ai",
      );
    }
  });
});

describe("buildContext", () => {
  it("puts the system prompt in its own field, not in messages", () => {
    // The adapters map `systemPrompt` to each vendor's native system field, which
    // is what makes prompt caching work.
    const context = buildContext({ systemPrompt: "Be brief.", input: "hello" });
    expect(context.systemPrompt).toBe("Be brief.");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.role).toBe("user");
  });

  it("omits a blank system prompt entirely", () => {
    expect(buildContext({ systemPrompt: "   ", input: "hi" }).systemPrompt).toBeUndefined();
    expect(buildContext({ input: "hi" }).systemPrompt).toBeUndefined();
  });

  it("appends the new input when given one", () => {
    const first = userMessage("earlier", 1000);
    const context = buildContext({ messages: [first], input: "later", timestamp: 2000 });
    expect(context.messages).toHaveLength(2);
    expect(context.messages[1]).toMatchObject({ role: "user", content: "later", timestamp: 2000 });
  });

  it("does not duplicate the turn already in the history", () => {
    // Regression: passing both `messages` ending in the user turn and `input`
    // sent the same prompt to the provider twice, doubling cost and confusing
    // the model. Omitting `input` must mean "send these messages as they are".
    const history = [userMessage("only once", 1000)];
    const context = buildContext({ messages: history });
    expect(context.messages).toHaveLength(1);
    expect(context.messages).not.toBe(history);
  });

  it("starts from nothing", () => {
    expect(buildContext({}).messages).toEqual([]);
  });
});

describe("extractText", () => {
  it("joins multiple text blocks", () => {
    const message = assistantMessage("", {
      content: [
        { type: "text", text: "first " },
        { type: "text", text: "second" },
      ],
    });
    expect(extractText(message)).toBe("first second");
  });

  it("ignores thinking and tool-call blocks", () => {
    const message = assistantMessage("visible", {
      content: [
        { type: "thinking", thinking: "hidden reasoning" } as never,
        { type: "text", text: "visible" },
      ],
    });
    expect(extractText(message)).toBe("visible");
  });

  it("trims trailing whitespace and tolerates odd content", () => {
    expect(extractText(assistantMessage("padded  \n"))).toBe("padded");
    expect(extractText({ ...assistantMessage(""), content: undefined as never })).toBe("");
  });
});

describe("extractError", () => {
  it("prefers the provider's own message", () => {
    expect(extractError(assistantMessage("", { errorMessage: "  rate limited  " }))).toBe(
      "rate limited",
    );
  });

  it("falls back to the stop reason", () => {
    expect(extractError(assistantMessage("", { stopReason: "aborted" }))).toContain("aborted");
  });

  it("says something usable when there is nothing to report", () => {
    expect(extractError(undefined)).toContain("without a usable reply");
  });
});

describe("runChatTurn", () => {
  const model = fakeModel();

  async function collect(events: AsyncGenerator<{ type: string; [key: string]: unknown }>) {
    const collected: Array<Record<string, unknown>> = [];
    for await (const event of events) {
      collected.push(event as Record<string, unknown>);
    }
    return collected;
  }

  it("streams text deltas and then completes", async () => {
    const runtime = fakeRuntime(replyEvents("hello there friend"));
    const events = await collect(
      runChatTurn({ runtime, model, context: buildContext({ input: "hi" }) }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "text",
      "text",
      "text",
      "complete",
    ]);
    expect(events.slice(0, 3).map((event) => event.delta).join("")).toBe("hello there friend");
  });

  it("passes the model, context, and options straight through", async () => {
    const runtime = fakeRuntime(replyEvents("ok"));
    const context = buildContext({ systemPrompt: "Be brief.", input: "hi" });
    await collect(
      runChatTurn({ runtime, model, context, options: { apiKey: "sk-test", temperature: 0.2 } }),
    );
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.model).toBe(model);
    expect(runtime.calls[0]?.context).toBe(context);
    expect(runtime.calls[0]?.options).toMatchObject({ apiKey: "sk-test", temperature: 0.2 });
  });

  it("reports thinking deltas separately from text", async () => {
    const message = assistantMessage("answer");
    const script: AssistantMessageEvent[] = [
      { type: "start", partial: message },
      { type: "thinking_start", contentIndex: 0, partial: message },
      { type: "thinking_delta", contentIndex: 0, delta: "considering", partial: message },
      { type: "thinking_end", contentIndex: 0, content: "considering", partial: message },
      { type: "text_delta", contentIndex: 1, delta: "answer", partial: message },
      { type: "done", reason: "stop", message },
    ];
    const events = await collect(
      runChatTurn({ runtime: fakeRuntime(script), model, context: buildContext({ input: "hi" }) }),
    );
    expect(events.map((event) => event.type)).toEqual(["thinking", "text", "complete"]);
  });

  it("turns a provider error event into a failure", async () => {
    const events = await collect(
      runChatTurn({
        runtime: fakeRuntime(failureEvents("overloaded")),
        model,
        context: buildContext({ input: "hi" }),
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "failed", error: "overloaded" });
  });

  it("turns a throwing runtime into a failure instead of an exception", async () => {
    // `createLlmRuntime` throws synchronously when no adapter is registered for
    // the model's api; a chat loop that let that escape would lose the input.
    const runtime = {
      stream(): never {
        throw new Error("No API provider registered for api: made-up");
      },
    };
    const events = await collect(
      runChatTurn({ runtime, model, context: buildContext({ input: "hi" }) }),
    );
    expect(events).toEqual([
      { type: "failed", error: "No API provider registered for api: made-up" },
    ]);
  });

  it("reports a stream that ends without a terminal event", async () => {
    const message = assistantMessage("partial");
    const script: AssistantMessageEvent[] = [
      { type: "start", partial: message },
      { type: "text_delta", contentIndex: 0, delta: "partial", partial: message },
    ];
    const events = await collect(
      runChatTurn({ runtime: fakeRuntime(script), model, context: buildContext({ input: "hi" }) }),
    );
    expect(events.map((event) => event.type)).toEqual(["text", "failed"]);
  });

  it("reports a stream that throws mid-flight", async () => {
    const message = assistantMessage("");
    const runtime = {
      stream() {
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
            yield { type: "start", partial: message };
            throw new Error("socket hang up");
          },
          result(): Promise<never> {
            return Promise.reject(new Error("socket hang up"));
          },
        };
      },
    };
    const events = await collect(
      runChatTurn({ runtime, model, context: buildContext({ input: "hi" }) }),
    );
    expect(events).toEqual([{ type: "failed", error: "socket hang up" }]);
  });

  it("ignores empty deltas", async () => {
    const message = assistantMessage("x");
    const script: AssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "", partial: message },
      { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
      { type: "done", reason: "stop", message },
    ];
    const events = await collect(
      runChatTurn({ runtime: fakeRuntime(script), model, context: buildContext({ input: "hi" }) }),
    );
    expect(events.map((event) => event.type)).toEqual(["text", "complete"]);
  });
});
