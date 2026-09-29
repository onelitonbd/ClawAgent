// The `agent` command: flag interpretation, the plan it prints, and what it does
// to files.
//
// `runAgent` is exercised with `dryRun` and with a scripted runtime over a real
// temp workspace, because the two things a user judges this command by are whether
// it says exactly what it will touch before touching it, and whether a one-shot run
// leaves an exit code a script can branch on.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_PROMPT_COMMANDS,
  DEFAULT_MAX_TURNS,
  describeAgentPlan,
  renderAgentEvent,
  resolveAgentFlags,
  runAgent,
} from "./agent.ts";
import {
  assistantMessage,
  fakeModel,
  fakePrompter,
  fakeRuntime,
  messageEvents,
  replyEvents,
  sink,
  toolCallMessage,
} from "../../test/chat-support.ts";
import { withWorkspace, type ToolFixture } from "../../test/tool-support.ts";
import { EXIT_CONFIG, EXIT_OK, EXIT_PROVIDER, EXIT_USAGE } from "./exit-codes.ts";
import { runCli } from "./main.ts";
import type { AgentTurnEvent } from "../agent/runner.ts";

let fixture: ToolFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

const config = () => ({
  config: { model: { provider: "anthropic", id: "claude-test" } },
  problems: [],
  file: undefined,
});
const env = () => ({ ANTHROPIC_API_KEY: "sk-test", HOME: "/tmp" });

describe("resolveAgentFlags", () => {
  it("defaults to ask with the documented turn budget", () => {
    const flags = resolveAgentFlags({});
    expect(flags.mode).toBe("ask");
    expect(flags.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(flags.error).toBeUndefined();
  });

  it("maps --yes to full and refuses to combine it with --approve", () => {
    expect(resolveAgentFlags({ yes: true }).mode).toBe("full");
    const clash = resolveAgentFlags({ yes: true, approve: "workspace" });
    expect(clash.error).toContain("cannot be combined");
    // Refusing is the point: picking a winner would let a loosening flag override
    // a tightening one depending on argument order.
    expect(clash.mode).not.toBe("workspace");
  });

  it("rejects an unknown mode instead of falling back to something permissive", () => {
    const flags = resolveAgentFlags({ approve: "yolo-ish" });
    expect(flags.error).toContain('unknown approval mode "yolo-ish"');
  });

  it("rejects a bad config value with the config's own key name", () => {
    const flags = resolveAgentFlags({ modeFromConfig: "sometimes" });
    expect(flags.error).toContain('agent.approve in config is "sometimes"');
  });

  it.each(["ask", "workspace", "full", "read-only"])("accepts %s", (mode) => {
    expect(resolveAgentFlags({ approve: mode }).mode).toBe(mode);
  });

  it("bounds --max-turns", () => {
    expect(resolveAgentFlags({ maxTurns: "5" }).maxTurns).toBe(5);
    expect(resolveAgentFlags({ maxTurns: "0" }).error).toContain("--max-turns");
    expect(resolveAgentFlags({ maxTurns: "900" }).error).toContain("--max-turns");
    expect(resolveAgentFlags({ maxTurns: "many" }).error).toContain("--max-turns");
  });

  it("prefers the flag over config for the workspace", () => {
    expect(resolveAgentFlags({ workspace: "/flagged", workspaceFromConfig: "/configured" }).workspace).toBe(
      "/flagged",
    );
    expect(resolveAgentFlags({ workspaceFromConfig: "/configured" }).workspace).toBe("/configured");
  });
});

describe("describeAgentPlan", () => {
  it("names the workspace, the mode, the tools, and says nothing was called", () => {
    const lines = describeAgentPlan({
      workspaceRoot: "/w",
      policy: "strict",
      mode: "ask",
      tools: ["read", "write"],
      modelLabel: "Anthropic",
      maxTurns: 12,
    });
    expect(lines.join("\n")).toContain("workspace: /w (strict paths)");
    expect(lines.join("\n")).toContain("approval : ask");
    expect(lines.join("\n")).toContain("tools    : read, write");
    expect(lines.join("\n")).toContain("up to 12 per message");
    expect(lines.at(-1)).toBe("no model call was made");
  });
});

describe("renderAgentEvent", () => {
  const render = (events: AgentTurnEvent[], showThinking = false): string => {
    const out = sink();
    const state = { inThinking: false, atLineStart: true };
    for (const event of events) {
      renderAgentEvent(event, out, false, showThinking, state);
    }
    return out.text();
  };

  it("streams text and puts tool lines on their own lines", () => {
    const text = render([
      { type: "assistant-text", delta: "hall" },
      { type: "tool-start", toolName: "read", args: {} },
      { type: "tool-end", toolName: "read", ok: true },
      { type: "assistant-text", delta: "o" },
    ]);
    expect(text).toContain("hall");
    expect(text).toContain("… read");
    expect(text).toContain("done: read");
    // Prose resumed after a tool line must not be glued to the end of it.
    // Exact output, because "does not glue prose onto the tool line" is what this
    // whole function is for.
    expect(text).toBe("hall\n… read\ndone: read\n\no");
  });

  it("hides reasoning unless asked", () => {
    expect(render([{ type: "thinking", delta: "secret plan" }])).not.toContain("secret plan");
    expect(render([{ type: "thinking", delta: "secret plan" }], true)).toContain("secret plan");
  });

  it("prints a failure inline", () => {
    expect(render([{ type: "failed", error: "network trouble" }])).toContain("network trouble");
  });
});

describe("runAgent", () => {
  it("prints the plan without touching the model on --dry-run", async () => {
    const fix = (fixture = withWorkspace());
    let called = 0;
    const result = await runAgent({
      env: env(),
      config: config(),
      stdout: sink(),
      stderr: sink(),
      dryRun: true,
      workspace: fix.root,
      approve: "read-only",
      runtimeFactory: async () => {
        called += 1;
        return fakeRuntime([]) as never;
      },
    });
    expect(result.exitCode).toBe(EXIT_OK);
    // The runtime *is* constructed: it happens inside the shared startup that
    // `chat` also uses, and forgoing it would mean a second startup path for the
    // sake of saving one dynamic import. What `--dry-run` promises is that no
    // prompt is sent, and `replies` is what proves that.
    expect(called).toBe(1);
    expect(result.replies).toEqual([]);
    expect(result.notes.join("\n")).toContain(`workspace: ${fix.root}`);
    expect(result.notes.join("\n")).toContain("approval : read-only");
    expect(result.notes.join("\n")).toContain("no model call was made");
  });

  it("runs a one-shot task that writes a file, with approvals off", async () => {
    const fix = (fixture = withWorkspace());
    // A script that advances per turn rather than replaying one response: a
    // fixed event list would be sent again after the tool result, and the loop
    // would faithfully keep writing the same file until the turn cap stopped it.
    let turn = 0;
    const runtime = fakeRuntime(() => {
      turn += 1;
      return turn === 1
        ? messageEvents(toolCallMessage("write", { path: "note.txt", content: "written by the agent\n" }))
        : replyEvents("wrote it");
    });
    const after = await runAgent({
      env: env(),
      config: config(),
      stdout: sink(),
      stderr: sink(),
      message: "write note.txt",
      workspace: fix.root,
      yes: true,
      prompter: fakePrompter([]),
      runtimeFactory: async () => runtime as never,
    });
    expect(after.exitCode).toBe(EXIT_OK);
    expect(readFileSync(path.join(fix.root, "note.txt"), "utf8")).toBe("written by the agent\n");
    expect(after.replies).toEqual(["wrote it"]);
    expect(runtime.calls).toHaveLength(2);
  });

  it("refuses a bad --approve before reading any credential", async () => {
    const out = sink();
    const err = sink();
    let built = 0;
    const result = await runAgent({
      env: env(),
      config: config(),
      stdout: out,
      stderr: err,
      message: "hi",
      approve: "sometimes",
      runtimeFactory: async () => {
        built += 1;
        return fakeRuntime([]) as never;
      },
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(built).toBe(0);
    expect(err.text()).toContain('unknown approval mode "sometimes"');
    expect(err.text()).toContain("clawagent agent --help");
  });

  it("requires a non-empty -m", async () => {
    const err = sink();
    const result = await runAgent({
      env: env(),
      config: config(),
      stdout: sink(),
      stderr: err,
      message: "   ",
      runtimeFactory: async () => fakeRuntime([]) as never,
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(err.text()).toContain("-m needs a non-empty message");
  });

  it("needs a terminal for an interactive run", async () => {
    const err = sink();
    const result = await runAgent({
      env: env(),
      config: config(),
      stdout: sink(),
      stderr: err,
      runtimeFactory: async () => fakeRuntime([]) as never,
    });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(err.text()).toContain("needs a terminal");
  });

  it("reports a missing API key as a config failure", async () => {
    const err = sink();
    const result = await runAgent({
      env: { HOME: "/tmp" },
      config: config(),
      stdout: sink(),
      stderr: err,
      message: "hi",
    });
    expect(result.exitCode).toBe(EXIT_CONFIG);
    expect(err.text()).toContain("ANTHROPIC_API_KEY");
  });

  it("returns the provider exit code when the one-shot turn fails", async () => {
    const fix = (fixture = withWorkspace());
    const runtime = fakeRuntime(() => {
      throw new Error("Connection error.");
    });
    const err = sink();
    const result = await runAgent({
      env: env(),
      config: config(),
      stdout: sink(),
      stderr: err,
      message: "do something",
      workspace: fix.root,
      yes: true,
      prompter: fakePrompter([]),
      runtimeFactory: async () => runtime as never,
    });
    expect(result.exitCode).toBe(EXIT_PROVIDER);
    expect(err.text()).toContain("Connection error.");
    // The hint tells a phone user what to check, which is the whole reason the
    // classification exists.
    expect(err.text()).toContain("Wi-Fi");
  });

  it("answers slash commands from the interactive loop", async () => {
    const fix = (fixture = withWorkspace());
    const out = sink();
    const runtime = fakeRuntime([
      ...replyEvents("ok then"),
      ...replyEvents("ok then"),
    ]);
    const result = await runAgent({
      env: env(),
      config: config(),
      stdout: out,
      stderr: sink(),
      prompter: fakePrompter(["/help", "/tools", "/workspace", "/approve read-only", "/nope", "/exit"]),
      workspace: fix.root,
      runtimeFactory: async () => runtime as never,
    });
    const text = out.text();
    expect(result.exitCode).toBe(EXIT_OK);
    for (const command of AGENT_PROMPT_COMMANDS) {
      expect(text).toContain(command.name.split(" ")[0]);
    }
    expect(text).toContain("read, write, edit, glob, grep, bash");
    expect(text).toContain(fix.root);
    expect(text).toContain("approval mode is now read-only");
    expect(text).toContain("unknown command /nope");
    // No slash command reached the model.
    expect(runtime.calls).toHaveLength(0);
  });

  it("keeps the session alive after a failed turn and stops on /exit", async () => {
    const fix = (fixture = withWorkspace());
    let turn = 0;
    const runtime = fakeRuntime(() => {
      turn += 1;
      if (turn === 1) {
        throw new Error("Connection error.");
      }
      return messageEvents(assistantMessage("recovered"));
    });
    const out = sink();
    const result = await runAgent({
      env: env(),
      config: config(),
      stdout: out,
      stderr: sink(),
      prompter: fakePrompter(["first", "second", "/exit"]),
      workspace: fix.root,
      yes: true,
      runtimeFactory: async () => runtime as never,
    });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(out.text()).toContain("Connection error.");
    expect(result.replies).toEqual(["recovered"]);
  });
});

describe("agent through runCli", () => {
  it("is a listed command with its own usage text", async () => {
    const result = await runCli({ argv: ["agent", "--help"], env: env() });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("--approve <mode>");
    expect(result.stdout).toContain("--workspace <dir>");
    expect(result.stdout).toContain("--dry-run");
  });

  it("rejects an unknown flag with usage, not a stack trace", async () => {
    const result = await runCli({ argv: ["agent", "--approve-nope"], env: env() });
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stderr).toContain("approve-nope");
  });

  it("runs --dry-run end to end without a key or a network", async () => {
    const fix = (fixture = withWorkspace());
    const result = await runCli({
      env: {
        ...env(),
        CLAWAGENT_HOME: path.join(fix.root, "state"),
        CLAWAGENT_PROVIDER: "anthropic",
        CLAWAGENT_MODEL: "claude-test",
      },
      argv: ["agent", "--dry-run", "--workspace", fix.root, "--yes"],
    });
    // A dry run still needs a usable model descriptor and key: what it promises is
    // no prompt, not no configuration. Printing a plan that could not have run
    // would make the flag useless for its one job.
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("approval : full");
    expect(result.stdout).toContain("no model call was made");
    expect(result.stdout).toContain(fix.root);
  });

  it("shows a read-only plan without the tools that run cannot have", async () => {
    const fix = (fixture = withWorkspace());
    const result = await runCli({
      env: {
        ...env(),
        CLAWAGENT_HOME: path.join(fix.root, "state"),
        CLAWAGENT_PROVIDER: "anthropic",
        CLAWAGENT_MODEL: "claude-test",
      },
      argv: ["agent", "--dry-run", "--approve", "read-only", "--workspace", fix.root],
    });
    // The one job of --dry-run is to tell you what a run would do. A plan that
    // lists `write` for a mode that has no `write` is worse than no plan: the
    // user reads it as "this run can edit files" and then watches the model fail
    // to, twice, per turn.
    expect(result.stdout).toContain("tools    : read, glob, grep");
    // Asserted as the shape the wrong answer would have, rather than as the
    // absence of the word "write": a temp directory in the fixture path can
    // contain anything, and a check that passes because of where mkdtemp put the
    // workspace is not a check.
    expect(result.stdout).not.toContain("read, write, edit");
  });
});
