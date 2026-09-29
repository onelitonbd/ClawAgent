// `clawagent chat` — both modes, with a fake runtime and a scripted prompter.
//
// Nothing here touches a network or a TTY. What is being pinned down is the
// behaviour a user depends on: a failed turn must not destroy the conversation,
// history must not duplicate a turn, Ctrl-C must reach the provider call, and a
// missing key must say exactly which variable to set.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AssistantMessageEvent, Context, Message } from "@openclaw/llm-core";
import type { OutputStream } from "./streams.ts";
import {
  CHAT_COMMAND,
  createReadlinePrompter,
  mergeModelFlagOverrides,
  renderChatCommands,
  runChat,
  type ChatPrompter,
} from "./chat.ts";
import { EXIT_CONFIG, EXIT_OK, EXIT_PROVIDER, EXIT_USAGE } from "./exit-codes.ts";
import type { ResolvedConfig } from "../config/config.ts";
import { ENV_OVERRIDES } from "../config/config.ts";
import {
  assistantMessage,
  fakePrompter,
  fakeRuntime,
  failureEvents,
  replyEvents,
  sink,
  type FakeRuntime,
  type RecordedCall,
} from "../../test/chat-support.ts";

const TEST_KEY = "sk-ant-api03-TESTKEYABCDEFG";

function config(overrides: ResolvedConfig["config"] = {}): ResolvedConfig {
  return {
    config: {
      model: { provider: "anthropic", id: "claude-test" },
      ...overrides,
    },
    file: undefined,
    problems: [],
  };
}

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: "/nonexistent-home", ANTHROPIC_API_KEY: TEST_KEY, ...overrides };
}

/** Runs one shot and returns everything a caller can observe. */
async function oneShot(params: {
  message?: string;
  runtime?: FakeRuntime;
  config?: ResolvedConfig;
  env?: NodeJS.ProcessEnv;
  showThinking?: boolean;
}) {
  const out = sink();
  const err = sink();
  const runtime = params.runtime ?? fakeRuntime(replyEvents("hello world"));
  const result = await runChat({
    ...(params.message === undefined ? {} : { message: params.message }),
    config: params.config ?? config(),
    env: params.env ?? env(),
    stdout: out,
    stderr: err,
    runtimeFactory: async () => runtime,
    ...(params.showThinking === undefined ? {} : { showThinking: params.showThinking }),
  });
  return { ...result, out: out.text(), err: err.text(), runtime };
}

/** Runs an interactive session over a scripted prompter. */
async function interactive(
  lines: readonly string[],
  params: { runtime?: FakeRuntime; config?: ResolvedConfig; env?: NodeJS.ProcessEnv } = {},
) {
  const out = sink();
  const err = sink();
  const prompter = fakePrompter(lines);
  const runtime = params.runtime ?? fakeRuntime(replyEvents("ok"));
  const result = await runChat({
    prompter,
    config: params.config ?? config(),
    env: params.env ?? env(),
    stdout: out,
    stderr: err,
    runtimeFactory: async () => runtime,
  });
  return { ...result, out: out.text(), err: err.text(), prompter, runtime };
}

describe("chat command spec", () => {
  it("is named chat and offers one-shot input", () => {
    expect(CHAT_COMMAND.name).toBe("chat");
    expect(CHAT_COMMAND.flags?.some((flag) => flag.name === "message" && flag.alias === "m")).toBe(
      true,
    );
  });

  it("documents every slash command it accepts", () => {
    const text = renderChatCommands().join("\n");
    for (const command of ["/help", "/model", "/system", "/clear", "/exit"]) {
      expect(text).toContain(command);
    }
  });
});

describe("one-shot mode", () => {
  it("prints the reply and exits zero", async () => {
    const result = await oneShot({ message: "hi" });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.replies).toEqual(["hello world"]);
    expect(result.out).toContain("hello world");
  });

  it("streams the text as deltas rather than one blob", async () => {
    // On a phone this is the difference between a reply that appears to hang and
    // one that visibly progresses.
    const chunks: string[] = [];
    const runtime = fakeRuntime(replyEvents("one two three"));
    const result = await runChat({
      message: "hi",
      config: config(),
      env: env(),
      stdout: { write: (chunk: string) => chunks.push(String(chunk)) },
      stderr: sink(),
      runtimeFactory: async () => runtime,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(chunks.filter((chunk) => chunk.trim().length > 0).length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("one two three");
  });

  it("prints no interactive banner", async () => {
    const result = await oneShot({ message: "hi" });
    expect(result.out).not.toContain("/help for commands");
  });

  it("passes the key and chat settings to the provider", async () => {
    const runtime = fakeRuntime(replyEvents("ok"));
    await oneShot({
      message: "hi",
      runtime,
      config: config({ chat: { temperature: 0.25, maxTokens: 321 } }),
    });
    expect(runtime.calls[0]?.options).toMatchObject({
      apiKey: TEST_KEY,
      temperature: 0.25,
      maxTokens: 321,
    });
  });

  it("sends the configured system prompt in its own field", async () => {
    const runtime = fakeRuntime(replyEvents("ok"));
    await oneShot({ message: "hi", runtime, config: config({ chat: { systemPrompt: "Be terse." } }) });
    const context = runtime.calls[0]?.context as Context;
    expect(context.systemPrompt).toBe("Be terse.");
    expect(context.messages).toHaveLength(1);
  });

  it("uses a default system prompt when none is configured", async () => {
    const runtime = fakeRuntime(replyEvents("ok"));
    await oneShot({ message: "hi", runtime });
    expect(runtime.calls[0]?.context.systemPrompt).toContain("ClawAgent");
  });

  it("honours the key override variable", async () => {
    const runtime = fakeRuntime(replyEvents("ok"));
    await oneShot({
      message: "hi",
      runtime,
      env: env({ [ENV_OVERRIDES.apiKey]: "sk-override" }),
    });
    expect(runtime.calls[0]?.options?.apiKey).toBe("sk-override");
  });

  it("rejects an empty message", async () => {
    const result = await oneShot({ message: "   " });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.err).toContain("-m needs a non-empty message");
  });

  it("reports a missing key with the variables to set", async () => {
    const result = await oneShot({ message: "hi", env: { HOME: "/nonexistent-home" } });
    expect(result.exitCode).toBe(EXIT_CONFIG);
    expect(result.err).toContain("no API key found");
    expect(result.err).toContain("ANTHROPIC_API_KEY");
    expect(result.err).toContain("clawagent doctor");
  });

  it("reports an unknown provider with a suggestion", async () => {
    const result = await oneShot({
      message: "hi",
      config: config({ model: { provider: "antropic", id: "x" } }),
    });
    expect(result.exitCode).toBe(EXIT_CONFIG);
    expect(result.err).toContain('did you mean "anthropic"');
  });

  it("reports a missing model id with a copyable example", async () => {
    const result = await oneShot({ message: "hi", config: { config: {}, file: undefined, problems: [] } });
    expect(result.exitCode).toBe(EXIT_CONFIG);
    expect(result.err).toContain("no model id");
    expect(result.err).toContain("CLAWAGENT_PROVIDER=anthropic");
  });

  it("surfaces config problems but still runs", async () => {
    // One bad number should not stop an otherwise usable config.
    const broken: ResolvedConfig = {
      config: { model: { provider: "anthropic", id: "claude-test" } },
      file: "/tmp/clawagent.json",
      problems: ["model.maxTokens must be a positive number"],
    };
    const result = await oneShot({ message: "hi", config: broken });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.err).toContain("config: model.maxTokens must be a positive number");
  });

  it("exits non-zero when the runtime cannot start", async () => {
    const err = sink();
    const result = await runChat({
      message: "hi",
      config: config(),
      env: env(),
      stdout: sink(),
      stderr: err,
      runtimeFactory: async () => {
        throw new Error("Cannot find package '@anthropic-ai/sdk'");
      },
    });
    expect(result.exitCode).toBe(EXIT_PROVIDER);
    expect(err.text()).toContain("could not start the model runtime");
    expect(err.text()).toContain("npm install --omit=dev");
  });

  it("exits non-zero and says why when the turn fails", async () => {
    const result = await oneShot({
      message: "hi",
      runtime: fakeRuntime(failureEvents("rate limited")),
    });
    expect(result.exitCode).toBe(EXIT_PROVIDER);
    expect(result.replies).toEqual([]);
    // Regression: a failed one-shot run used to exit non-zero in complete
    // silence, which in a shell script is indistinguishable from never running.
    expect(result.err).toContain("error: rate limited");
  });

  it("keeps partial text on stdout when a turn fails mid-stream", async () => {
    // The user should still see what arrived before the connection dropped.
    const message = assistantMessage("");
    const script: AssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "partial answer", partial: message },
      { type: "error", reason: "error", error: assistantMessage("", { errorMessage: "connection reset" }) },
    ];
    const result = await oneShot({ message: "hi", runtime: fakeRuntime(script) });
    expect(result.out).toContain("partial answer");
    expect(result.err).toContain("connection reset");
    expect(result.exitCode).toBe(EXIT_PROVIDER);
  });

  it("needs a prompter for interactive use", async () => {
    const err = sink();
    const result = await runChat({ config: config(), env: env(), stdout: sink(), stderr: err });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(err.text()).toContain("interactive chat needs a terminal prompter");
  });

  it("prints thinking deltas only when asked", async () => {
    const message = assistantMessage("answer");
    const script: AssistantMessageEvent[] = [
      { type: "thinking_delta", contentIndex: 0, delta: "pondering", partial: message },
      { type: "text_delta", contentIndex: 1, delta: "answer", partial: message },
      { type: "done", reason: "stop", message },
    ];
    const quiet = await oneShot({ message: "hi", runtime: fakeRuntime(script) });
    expect(quiet.out).not.toContain("pondering");
    const loud = await oneShot({
      message: "hi",
      runtime: fakeRuntime(script),
      showThinking: true,
    });
    expect(loud.out).toContain("pondering");
  });
});

describe("interactive mode", () => {
  it("prints a banner naming the model and masking the key", async () => {
    const result = await interactive(["/exit"]);
    expect(result.out).toContain("anthropic/claude-test via anthropic-messages");
    expect(result.out).toContain("/help for commands");
    expect(result.out).not.toContain(TEST_KEY);
  });

  it("runs a turn and leaves on /exit", async () => {
    const result = await interactive(["hello", "/exit"]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.replies).toEqual(["ok"]);
    expect(result.runtime.calls).toHaveLength(1);
  });

  it("leaves on /quit and on end of input", async () => {
    expect((await interactive(["/quit"])).exitCode).toBe(EXIT_OK);
    expect((await interactive(["hello"])).exitCode).toBe(EXIT_OK);
  });

  it("ignores blank lines", async () => {
    const result = await interactive(["", "   ", "/exit"]);
    expect(result.runtime.calls).toHaveLength(0);
  });

  it("answers /help without a model call", async () => {
    const result = await interactive(["/help", "/exit"]);
    expect(result.out).toContain("/clear");
    expect(result.runtime.calls).toHaveLength(0);
  });

  it("answers /model with the endpoint details", async () => {
    const result = await interactive(["/model", "/exit"]);
    expect(result.out).toContain("anthropic/claude-test");
    expect(result.out).toContain("https://api.anthropic.com/v1");
    expect(result.out).toContain("maxTokens");
  });

  it("shows and sets the system prompt", async () => {
    const runtime = fakeRuntime(replyEvents("ok"));
    const result = await interactive(["/system", "/system Reply in Bengali.", "hello"], { runtime });
    expect(result.out).toContain("ClawAgent");
    expect(result.out).toContain("system prompt set");
    expect(runtime.calls[0]?.context.systemPrompt).toBe("Reply in Bengali.");
  });

  it("clears the conversation", async () => {
    const runtime = fakeRuntime(replyEvents("ok"));
    await interactive(["first", "/clear", "second"], { runtime });
    expect(runtime.calls).toHaveLength(2);
    expect((runtime.calls[0]?.context.messages ?? [])).toHaveLength(1);
    // After /clear the second turn starts from scratch, not from the first.
    expect((runtime.calls[1]?.context.messages ?? [])).toHaveLength(1);
  });

  it("reports an unknown slash command and keeps going", async () => {
    const result = await interactive(["/frobnicate", "hello", "/exit"]);
    expect(result.out).toContain("unknown command /frobnicate");
    expect(result.replies).toEqual(["ok"]);
  });

  it("carries the conversation into the next turn exactly once", async () => {
    // Regression: the user turn was appended to history and then passed again as
    // `input`, so the provider saw the same prompt twice and cost doubled.
    const runtime = fakeRuntime((call: RecordedCall) => {
      const index = call.context.messages.filter((message) => message.role === "user").length;
      return replyEvents(`reply ${index}`);
    });
    const result = await interactive(["first", "second", "/exit"], { runtime });
    expect(result.replies).toEqual(["reply 1", "reply 2"]);
    const second = runtime.calls[1]?.context.messages as Message[];
    expect(second).toHaveLength(3);
    expect(second.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(second.map((message) => (message.role === "user" ? message.content : undefined)))
      .toEqual(["first", undefined, "second"]);
  });

  it("keeps the loop alive after a failed turn and leaves history untouched", async () => {
    // Discriminate on attempt count, not history length: after a failed turn the
    // history is rolled back, so the retry looks exactly like the first attempt.
    // That is the intended behaviour, and it is asserted separately below.
    let attempt = 0;
    const runtime = fakeRuntime(() => {
      attempt += 1;
      return attempt === 1 ? failureEvents("overloaded") : replyEvents("recovered");
    });
    const result = await interactive(["boom", "again", "/exit"], { runtime });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.err).toContain("overloaded");
    expect(result.err).toContain("conversation is unchanged");
    expect(result.replies).toEqual(["recovered"]);
    // The failed turn must not have left a dangling user message behind.
    expect(runtime.calls[1]?.context.messages).toHaveLength(1);
  });

  it("aborts the provider call on interrupt", async () => {
    const prompter = fakePrompter(["hello", "/exit"]);
    const calls: RecordedCall[] = [];
    const message = assistantMessage("partial");
    const interrupting = {
      async stream(model: RecordedCall["model"], context: Context, options: RecordedCall["options"]) {
        calls.push({ model, context, options });
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
            yield { type: "start", partial: message };
            // The user hits Ctrl-C mid-reply.
            prompter.interrupt();
            yield { type: "text_delta", contentIndex: 0, delta: "partial", partial: message };
            yield { type: "done", reason: "stop", message };
          },
          result: (): Promise<typeof message> => Promise.resolve(message),
        };
      },
    };
    const out = sink();
    const result = await runChat({
      prompter,
      config: config(),
      env: env(),
      stdout: out,
      stderr: sink(),
      runtimeFactory: async () => interrupting,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(calls[0]?.options?.signal?.aborted).toBe(true);
  });

  it("reports an interrupt seen between turns and drops the line", async () => {
    // Ctrl-C pressed while the prompt is idle should cancel that input rather
    // than send it: the user changed their mind, and sending anyway would be the
    // one thing they did not ask for.
    let interrupt: (() => void) | undefined;
    let firstCall = true;
    const prompter: ChatPrompter = {
      async next(): Promise<string | undefined> {
        if (firstCall) {
          firstCall = false;
          interrupt?.();
          return "never sent";
        }
        return undefined;
      },
      onInterrupt(handler: () => void): void {
        interrupt = handler;
      },
      close(): void {},
    };
    const out = sink();
    const runtime = fakeRuntime(replyEvents("ok"));
    const result = await runChat({
      prompter,
      config: config(),
      env: env(),
      stdout: out,
      stderr: sink(),
      runtimeFactory: async () => runtime,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(out.text()).toContain("(interrupted)");
    expect(runtime.calls).toHaveLength(0);
  });
});

describe("mergeModelFlagOverrides", () => {
  it("lets flags win over the config file", () => {
    const merged = mergeModelFlagOverrides(config(), {
      model: "claude-haiku",
      provider: "google",
      "base-url": "https://gateway.test/v1",
      api: "openai-completions",
    });
    expect(merged.config.model).toEqual({
      provider: "google",
      id: "claude-haiku",
      baseUrl: "https://gateway.test/v1",
      api: "openai-completions",
    });
    expect(merged.problems).toEqual([]);
  });

  it("applies a token budget to both the model and the request", () => {
    const merged = mergeModelFlagOverrides(config(), { "max-tokens": "256" });
    expect(merged.config.model?.maxTokens).toBe(256);
    expect(merged.config.chat?.maxTokens).toBe(256);
  });

  it("reports a non-numeric token budget", () => {
    const merged = mergeModelFlagOverrides(config(), { "max-tokens": "many" });
    expect(merged.problems).toContain("--max-tokens must be a positive number");
  });

  it("sets the system prompt", () => {
    expect(mergeModelFlagOverrides(config(), { system: "Be brief." }).config.chat?.systemPrompt).toBe(
      "Be brief.",
    );
  });

  it("ignores flags that were not given", () => {
    const merged = mergeModelFlagOverrides(config(), { json: true, "show-thinking": true });
    expect(merged.config.model).toEqual({ provider: "anthropic", id: "claude-test" });
  });

  it("carries existing problems through", () => {
    const merged = mergeModelFlagOverrides(
      { config: {}, file: undefined, problems: ["model.id must be a non-empty string"] },
      {},
    );
    expect(merged.problems).toEqual(["model.id must be a non-empty string"]);
  });
});

describe("createReadlinePrompter", () => {
  /** A piped stdin, which is how a script or a redirected file drives chat. */
  function piped() {
    const input = new PassThrough();
    const out = sink();
    const prompter = createReadlinePrompter({
      input: input as unknown as NodeJS.ReadStream,
      output: out,
      prompt: "> ",
    });
    return { input, out, prompter };
  }

  it("delivers piped lines in order when they all arrive at once", async () => {
    // Regression: `interface.question()` only hears the *next* line event, so
    // with piped input every line after the first was dropped and the loop hung
    // at end of input, exiting 13 on an unsettled await.
    const { input, prompter } = piped();
    input.write("/help\n/model\n/system\n");
    input.end();
    expect(await prompter.next()).toBe("/help");
    expect(await prompter.next()).toBe("/model");
    expect(await prompter.next()).toBe("/system");
    expect(await prompter.next()).toBeUndefined();
  });

  it("resolves a waiter that was registered before the input arrived", async () => {
    const { input, prompter } = piped();
    const pending = prompter.next();
    input.write("hello\n");
    input.end();
    expect(await pending).toBe("hello");
    expect(await prompter.next()).toBeUndefined();
  });

  it("keeps returning undefined after end of input", async () => {
    const { input, prompter } = piped();
    input.end();
    expect(await prompter.next()).toBeUndefined();
    expect(await prompter.next()).toBeUndefined();
    prompter.close();
    expect(await prompter.next()).toBeUndefined();
  });

  it("wakes a pending reader when input ends", async () => {
    // Without this, Ctrl-D during an idle prompt would hang instead of exiting.
    const { input, prompter } = piped();
    const pending = prompter.next();
    input.end();
    expect(await pending).toBeUndefined();
  });

  it("does not write a prompt into a piped transcript", async () => {
    const { input, out, prompter } = piped();
    input.write("/exit\n");
    input.end();
    await prompter.next();
    await prompter.next();
    expect(out.text()).not.toContain("> ");
  });

  it("writes the prompt on a terminal", async () => {
    // readline's terminal mode needs an EventEmitter as its output, so a plain
    // write-sink cannot stand in for a TTY. A PassThrough marked `isTTY` is the
    // closest honest fake: it is what `process.stdout` is, minus the ioctl.
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const written: string[] = [];
    output.on("data", (chunk) => written.push(String(chunk)));
    const prompter = createReadlinePrompter({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as OutputStream,
      prompt: "> ",
    });
    input.write("/exit\n");
    input.end();
    await prompter.next();
    await prompter.next();
    expect(written.join("")).toContain("> ");
    prompter.close();
  });

  it("handles a blank line without losing the next one", async () => {
    const { input, prompter } = piped();
    input.write("\nhello\n");
    input.end();
    expect(await prompter.next()).toBe("");
    expect(await prompter.next()).toBe("hello");
  });
});
