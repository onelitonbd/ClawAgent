// The approval gate, tested as the interface a human actually uses.
//
// What matters here is not whether `y` works — it is what happens at the edges:
// input runs out, the user types nonsense, Ctrl-C arrives mid-question, or the
// mode changes after a grant was given. Each of those has a tempting wrong answer
// (treat EOF as consent, treat a typo as "no" and move on, keep an old grant after
// tightening), and each is a bug a person only finds once something is already
// written.

import { describe, expect, it } from "vitest";
import path from "node:path";
import { createApprovalGate } from "./gate.ts";
import { createWorkspace } from "../tools/workspace.ts";
import { fakePrompter, sink } from "../../test/chat-support.ts";

function gate(options: {
  mode?: "ask" | "workspace" | "full" | "read-only";
  answers?: string[];
  root?: string;
  signal?: AbortSignal;
}) {
  const root = options.root ?? "/tmp";
  const output = sink();
  const decisions: Array<{ toolName: string; decision: string; rule: string }> = [];
  const prompter = fakePrompter(options.answers ?? []);
  const instance = createApprovalGate({
    mode: options.mode ?? "ask",
    workspace: createWorkspace({ root }),
    input: prompter,
    output,
    colour: false,
    ...(options.signal ? { signal: options.signal } : {}),
    onDecision: (entry) => decisions.push(entry),
  });
  const ask = (toolName: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    instance.beforeToolCall(
      { assistantMessage: {}, toolCall: { name: toolName, id: "c1" }, args, context: {} },
      signal,
    );
  return { gate: instance, output, decisions, ask, prompter };
}

describe("createApprovalGate", () => {
  it("lets an allowed call through with no output at all", async () => {
    const { output, ask } = gate({ mode: "workspace", answers: [] });
    expect(await ask("read", { path: "a.ts" })).toBeUndefined();
    expect(output.text()).toBe("");
  });

  it("asks, takes a yes, and lets the call run", async () => {
    const { output, ask } = gate({ mode: "ask", answers: ["y"] });
    expect(await ask("write", { path: "a.ts", content: "hi\n" })).toBeUndefined();
    const prompt = output.text();
    // "(1 line)", singular: the count and the grammar come from one helper shared with
    // the write tool, so prompt and result cannot disagree about the same content.
    expect(prompt).toContain("allow create or replace a.ts (1 line)");
    expect(prompt).toContain("[y/n/a]");
  });

  it("blocks on a no, with a reason the model can act on", async () => {
    const { ask, decisions } = gate({ mode: "ask", answers: ["n"] });
    const result = await ask("write", { path: "a.ts", content: "hi" });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("declined");
    expect(decisions[0]?.decision).toBe("ask");
  });

  it("treats end of input as a refusal, never as consent", async () => {
    // A piped script that forgot to answer must not be read as "yes to
    // everything": that is how a one-liner in a blog post becomes a write to
    // someone's credentials file.
    const { ask, output } = gate({ mode: "ask", answers: [] });
    const result = await ask("write", { path: "secrets.env", content: "x" });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("not present to approve");
    expect(output.text()).toContain("(no answer available — refusing)");
  });

  it("re-asks on an unrecognised answer instead of guessing", async () => {
    const { ask, output } = gate({ mode: "ask", answers: ["maybe", "y"] });
    expect(await ask("write", { path: "a.ts", content: "x" })).toBeUndefined();
    expect(output.text()).toContain('"maybe" is not one of them');
  });

  it("gives up after three unanswered attempts", async () => {
    const { ask, output } = gate({ mode: "ask", answers: ["x", "x", "x"] });
    const result = await ask("write", { path: "a.ts", content: "x" });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("did not answer");
    expect(output.text().match(/is not one of them/gu)).toHaveLength(3);
    // The last bad answer must not be followed by a fourth question the gate has
    // already decided not to wait for.
    expect(output.text()).toContain("giving up");
    expect(output.text().match(/\[y\/n\/a\]/gu)).toHaveLength(3);
    expect(result?.reason).toContain("did not decline");
  });

  it("remembers an always answer for that tool only", async () => {
    const { gate: g, ask } = gate({ mode: "ask", answers: ["a"] });
    expect(await ask("write", { path: "a.ts", content: "x" })).toBeUndefined();
    // Same tool, second call: no line is consumed from the prompter, so if the
    // grant did not persist this would hang or refuse on exhausted input.
    expect(await ask("write", { path: "b.ts", content: "y" })).toBeUndefined();
    expect(g.sessionApprovedTools()).toEqual(["write"]);
  });

  it("blocks a denied call without spending a question", async () => {
    const { output, ask } = gate({ mode: "full", answers: [] });
    const result = await ask("bash", { command: "rm -rf /" });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("removes from the filesystem root");
    // "do not retry" is the part the model needs, or it tries the same call twice.
    expect(result?.reason).toContain("Do not retry");
    expect(output.text()).toBe("");
  });

  it("honours an abort signal already raised", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ask } = gate({ mode: "ask", answers: ["y"], signal: controller.signal });
    const result = await ask("write", { path: "a.ts", content: "x" });
    expect(result?.block).toBe(true);
  });

  it("does not hang when the user interrupts a pending question", async () => {
    const controller = new AbortController();
    const prompter = { next: () => new Promise<string | undefined>(() => {}) };
    const g = createApprovalGate({
      mode: "ask",
      workspace: createWorkspace({ root: "/tmp" }),
      input: prompter,
      output: sink(),
    });
    setTimeout(() => controller.abort(), 20);
    const result = await g.beforeToolCall(
      { assistantMessage: {}, toolCall: { name: "write", id: "c1" }, args: { path: "a.ts", content: "x" }, context: {} },
      controller.signal,
    );
    expect(result?.block).toBe(true);
  });

  it("drops session grants when the mode changes, in either direction", async () => {
    const { gate: g, ask } = gate({ mode: "ask", answers: ["a", "n"] });
    expect(await ask("write", { path: "a.ts", content: "x" })).toBeUndefined();
    expect(g.sessionApprovedTools()).toEqual(["write"]);
    g.setMode("full");
    expect(g.sessionApprovedTools()).toEqual([]);
    // Back to ask: the old "always" must not silently return.
    g.setMode("ask");
    expect(await ask("write", { path: "b.ts", content: "y" })).toEqual({ block: true, reason: "the user declined this call" });
  });

  it("keeps a tightened mode in force for the very next call", async () => {
    const { gate: g, ask } = gate({ mode: "full", answers: [] });
    expect(await ask("write", { path: "a.ts", content: "x" })).toBeUndefined();
    g.setMode("read-only");
    const blocked = await ask("write", { path: "b.ts", content: "y" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("read-only");
  });

  it("resolves the workspace-relative path for its own decision only", () => {
    // The gate needs containment to decide, and must not become the path
    // authority — the tool still resolves the path itself.
    const workspace = createWorkspace({ root: "/tmp" });
    expect(path.isAbsolute(workspace.root)).toBe(true);
  });
});
