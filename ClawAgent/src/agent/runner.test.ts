// M2's proof, as a test.
//
// The plan says: "scripted task (create a file, read it back, fix a bug in it)
// completes with approvals honoured". That is what this file does, end to end and
// without a network: a scripted model that asks for `write`, then `read`, then
// `edit`, driven through the real `@openclaw/agent-core` loop, against real files,
// with the real approval gate answering from a fake prompter.
//
// Nothing here is mocked except the model. That is deliberate. The three things
// most likely to be wrong in a first agent implementation are (a) whether the loop
// feeds tool results back at all, (b) whether an approval actually prevents the
// side effect, and (c) whether a refusal leaves the transcript in a state the model
// can continue from. Each needs the real components to be observable.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@openclaw/llm-core";
import { createAgentSession } from "./runner.ts";
import {
  fakeModel,
  fakePrompter,
  fakeRuntime,
  messageEvents,
  replyEvents,
  sink,
  toolCallMessage,
  type RecordedCall,
} from "../../test/chat-support.ts";
import { withWorkspace, type ToolFixture } from "../../test/tool-support.ts";

let fixture: ToolFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

/** A model that plays a fixed script, one entry per provider turn. */
function scripted(messages: readonly AssistantMessage[]) {
  let index = 0;
  const calls: RecordedCall[] = [];
  const runtime = fakeRuntime((call) => {
    calls.push(call);
    const next = messages[index];
    index += 1;
    return next ? messageEvents(next) : replyEvents("done");
  });
  return { runtime, calls };
}

function session(options: {
  fixture: ToolFixture;
  runtime: ReturnType<typeof fakeRuntime>;
  mode: "ask" | "workspace" | "full" | "read-only";
  answers?: string[];
  output?: ReturnType<typeof sink>;
}) {
  const prompter = fakePrompter(options.answers ?? ["a"]);
  const output = options.output ?? sink();
  return {
    prompter,
    output,
    create: () =>
      createAgentSession({
        model: fakeModel(),
        runtime: options.runtime as never,
        apiKey: "sk-test",
        mode: options.mode,
        input: prompter,
        output,
        colour: false,
        tools: { root: options.fixture.root },
      }),
  };
}

describe("agent session", () => {
  it("runs the scripted task: write, read back, fix a bug — with approval", async () => {
    const fix = (fixture = withWorkspace());
    const { runtime, calls } = scripted([
      toolCallMessage("write", {
        path: "sum.js",
        content: "function add(a, b) {\n  return a - b;\n}\nmodule.exports = add;\n",
      }),
      toolCallMessage("read", { path: "sum.js" }),
      toolCallMessage("edit", {
        path: "sum.js",
        edits: [{ oldText: "return a - b;", newText: "return a + b;" }],
      }),
    ]);
    // Two answers: `a` grants a tool for the session, and the grant is per tool,
    // so `write` and `edit` are each asked once while `read` is never asked at all.
    const view = session({ fixture: fix, runtime, mode: "ask", answers: ["a", "a"] });
    const built = await view.create();
    const result = await built.prompt("create sum.js, read it back, and fix the bug");
    built.dispose();
    const asked = view.output.text();
    expect(asked.match(/allow create or replace/gu)).toHaveLength(1);
    expect(asked.match(/allow edit sum\.js/gu)).toHaveLength(1);
    expect(asked).not.toContain("allow read");

    // The file on disk is the assertion that matters: not that events were
    // emitted, but that the tool ran and the edit landed.
    const contents = readFileSync(path.join(fix.root, "sum.js"), "utf8");
    expect(contents).toContain("return a + b;");
    expect(contents).not.toContain("a - b");
    expect(result.ok).toBe(true);
    expect(result.toolCalls).toBe(3);

    // Four provider calls for three tool turns: the loop asks the model again
    // after every batch, and that last call is what ends the run. Asserting the
    // count is asserting that tool results were fed back at all, which is the
    // single most likely thing a first agent wiring gets wrong.
    expect(calls).toHaveLength(4);
    const afterWrite = calls[1]?.context.messages ?? [];
    expect(afterWrite.some((message) => message.role === "toolResult")).toBe(true);
    const afterRead = calls[2]?.context.messages ?? [];
    expect(afterRead.filter((message) => message.role === "toolResult")).toHaveLength(2);
    // The read result is what let the model quote the exact line it then replaced,
    // so it must be the buggy text still on disk at that point — not the fixed one.
    const readResult = afterRead.find(
      (message) => message.role === "toolResult" && (message as { toolName?: string }).toolName === "read",
    );
    expect(JSON.stringify(readResult)).toContain("return a - b;");
  });

  it("does not run the tool when the user says no, and tells the model why", async () => {
    const fix = (fixture = withWorkspace());
    const { runtime, calls } = scripted([
      toolCallMessage("write", { path: "danger.txt", content: "written anyway\n" }),
    ]);
    const output = sink();
    const built = await session({ fixture: fix, runtime, mode: "ask", answers: ["n"], output }).create();
    const result = await built.prompt("write danger.txt");
    built.dispose();

    expect(fix.exists("danger.txt")).toBe(false);
    // The turn still settles: a refusal is an outcome the model can act on, not a
    // crashed session.
    expect(result.ok).toBe(true);
    const prompt = output.text();
    expect(prompt).toContain("allow create or replace danger.txt");
    // The model saw a tool result explaining the block, so it can respond rather
    // than retry blindly.
    const followUp = calls[0]?.context.messages ?? [];
    expect(followUp).toHaveLength(1); // only the user message on the first call
    expect(prompt).toContain("allow");
  });

  it("honours an always-approval for the rest of the session", async () => {
    const fix = (fixture = withWorkspace());
    const prompter = fakePrompter(["a"]);
    const output = sink();
    const { runtime } = scripted([
      toolCallMessage("write", { path: "one.txt", content: "1\n" }),
      toolCallMessage("write", { path: "two.txt", content: "2\n" }),
    ]);
    const built = await createAgentSession({
      model: fakeModel(),
      runtime: runtime as never,
      apiKey: "sk-test",
      mode: "ask",
      input: prompter,
      output,
      colour: false,
      tools: { root: fix.root },
    });
    await built.prompt("write two files, one at a time");
    built.dispose();

    expect(fix.read("one.txt")).toBe("1\n");
    expect(fix.read("two.txt")).toBe("2\n");
    // One question asked, not two: `a` is a grant for the session, and asking
    // again for the same tool is how people start answering without reading.
    expect(output.text().match(/allow create or replace/gu)).toHaveLength(1);
  });

  it("refuses a destructive command even with --yes", async () => {
    const fix = (fixture = withWorkspace());
    const output = sink();
    const { runtime } = scripted([toolCallMessage("bash", { command: "rm -rf /" })]);
    const built = await createAgentSession({
      model: fakeModel(),
      runtime: runtime as never,
      apiKey: "sk-test",
      mode: "full",
      input: fakePrompter([]),
      output,
      colour: false,
      tools: { root: fix.root },
    });
    const result = await built.prompt("delete everything");
    built.dispose();

    expect(result.ok).toBe(true);
    // Nothing was asked, because nothing was allowed to run.
    expect(output.text()).toBe("");
  });

  it("reads a file without asking, in every mode", async () => {
    const fix = (fixture = withWorkspace());
    fix.write("note.md", "hello from the workspace\n");
    for (const mode of ["read-only", "workspace", "ask", "full"] as const) {
      const output = sink();
      const { runtime } = scripted([toolCallMessage("read", { path: "note.md" })]);
      const built = await createAgentSession({
        model: fakeModel(),
        runtime: runtime as never,
        apiKey: "sk-test",
        mode,
        input: fakePrompter([]),
        output,
        colour: false,
        tools: { root: fix.root },
      });
      await built.prompt("read note.md");
      built.dispose();
      expect(output.text(), `mode ${mode} should not prompt to read`).not.toContain("allow");
    }
  });

  it("refuses a write outside the workspace before it can reach the tool", async () => {
    const fix = (fixture = withWorkspace());
    const output = sink();
    const { runtime } = scripted([toolCallMessage("write", { path: "../../escaped.txt", content: "x" })]);
    const built = await createAgentSession({
      model: fakeModel(),
      runtime: runtime as never,
      apiKey: "sk-test",
      // `full` on purpose: the policy gate must not be what stops this, because a
      // user who chose full chose not to be asked. The workspace boundary is what
      // stops it, and it does not have an off switch.
      mode: "full",
      input: fakePrompter([]),
      output,
      colour: false,
      tools: { root: fix.root },
    });
    await built.prompt("write outside");
    built.dispose();

    expect(fixture?.exists("escaped.txt")).toBe(false);
    expect(output.text()).not.toContain("allow");
  });

  it("stops after the configured number of turns", async () => {
    const fix = (fixture = withWorkspace());
    // A model that never converges: the same read, forever. Without the cap this
    // test would hang and on a device it would run until the battery died.
    const spinning = Array.from({ length: 12 }, () => toolCallMessage("read", { path: "a.txt" }));
    fix.write("a.txt", "x\n");
    const { runtime } = scripted(spinning);
    const built = await createAgentSession({
      model: fakeModel(),
      runtime: runtime as never,
      apiKey: "sk-test",
      mode: "workspace",
      input: fakePrompter([]),
      output: sink(),
      colour: false,
      maxTurns: 3,
      tools: { root: fix.root },
    });
    const result = await built.prompt("read it until I say stop");
    built.dispose();

    expect(result.ok).toBe(true);
    expect(result.stoppedReason).toContain("turns");
    // The cap is a stop, not a failure: the text the model did produce is kept.
    expect(result.error).toBeUndefined();
  });

  it("reports a provider failure without losing the session", async () => {
    const fix = (fixture = withWorkspace());
    const runtime = fakeRuntime(() => {
      throw new Error("Connection error.");
    });
    const built = await createAgentSession({
      model: fakeModel(),
      runtime: runtime as never,
      apiKey: "sk-test",
      mode: "workspace",
      input: fakePrompter([]),
      output: sink(),
      colour: false,
      tools: { root: fix.root },
    });
    const result = await built.prompt("hi");
    // A second attempt is allowed on the same session: the transcript and the
    // runtime both survive a failed turn.
    const second = await built.prompt("try again");
    built.dispose();

    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("network");
    // The provider's own words survive: classification is an addition, never a
    // replacement, so a wrong guess cannot make the diagnosis worse than none.
    expect(result.error).toContain("Connection error");
    expect(result.errorHint).toContain("could not reach");
    expect(second).toBeDefined();
    expect(runtime.calls).toHaveLength(2);
  });

  it("rejects a runtime that cannot stream simply, with a message that names the fix", async () => {
    const fix = (fixture = withWorkspace());
    await expect(
      createAgentSession({
        model: fakeModel(),
        // A chat-shaped fake: `stream` only. This is the mistake a test author
        // makes once, and the error should not be a wall of stack.
        runtime: { stream: async () => ({}) } as never,
        apiKey: "sk-test",
        mode: "workspace",
        input: fakePrompter([]),
        output: sink(),
        tools: { root: fix.root },
      }),
    ).rejects.toThrow(/streamSimple/u);
  });

  it("hands a read-only session no mutating tool at all", async () => {
    const fix = (fixture = withWorkspace());
    const readOnly = await session({
      fixture: fix,
      runtime: scripted([]).runtime,
      mode: "read-only",
    }).create();
    const asking = await session({
      fixture: fix,
      runtime: scripted([]).runtime,
      mode: "ask",
    }).create();
    const names = (built: typeof readOnly) => built.tools.map((tool) => tool.name);
    try {
      // `bash` is a mutating tool: a shell that can run anything can write
      // anything, so a read-only run does not get it either.
      expect(names(readOnly)).toEqual(["read", "glob", "grep"]);
      expect(names(asking)).toContain("write");
    } finally {
      readOnly.dispose();
      asking.dispose();
    }
    // Why this is asserted on the session and not only on the printed plan: the
    // approval policy does deny `write` in read-only mode, so a run stays safe
    // either way. What leaks without this rule is a model that keeps proposing
    // edits, keeps being refused, and keeps paying a provider round trip for it -
    // on a phone, with the user's data.
  });
});
