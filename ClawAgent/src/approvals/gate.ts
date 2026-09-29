// The approval gate: policy verdict in, user answer out.
//
// WHY THIS DOES NOT USE `terminal-core`'s select prompt
//
// The rebuild plan said "approval prompts via terminal-core". Its styled select
// wraps `@clack/prompts`, which puts the terminal in raw mode and drives a cursor
// — that is three new npm dependencies and, decisively, no non-TTY path: with
// stdin redirected it reports `terminal = false` and closes. This milestone's own
// proof is a scripted session that approves calls from a pipe, and so is every
// future automation of this host. A prompt that cannot answer "y" from stdin is
// the wrong tool, so the gate reads lines through the same prompter `chat` uses
// and ClawAgent stays dependency-free here.
//
// The rest of the file is about not being annoying without being reckless:
//   - one line per prompt, with the exact command or path shown;
//   - `a`lways for the session, `n`o, and anything else re-asks rather than
//     guessing (a typo must not become a write);
//   - end of input means "no", never "yes" — a piped script that forgot to answer
//     must not be interpreted as consent;
//   - the abort signal is honoured while waiting, because Ctrl-C during a prompt
//     has to cancel the turn, not hang it.

import { decide, describeCall, type ApprovalMode } from "./policy.ts";
import type { Workspace } from "../tools/workspace.ts";
import { isInsideRoot } from "../tools/workspace.ts";
import path from "node:path";

/** The bits of `chat`'s prompter this gate needs. Kept narrow on purpose. */
export type ApprovalInput = {
  next(): Promise<string | undefined>;
};

export type ApprovalWriter = {
  write(text: string): void;
};

export type ApprovalGateOptions = {
  mode: ApprovalMode;
  workspace: Workspace;
  input: ApprovalInput;
  output: ApprovalWriter;
  /** Colours are off when the stream is not a TTY; the caller decides. */
  colour?: boolean;
  /** Called after every decision so the runner can log and tests can assert. */
  onDecision?: (entry: { toolName: string; decision: string; rule: string }) => void;
  signal?: AbortSignal;
};

export type ApprovalGate = {
  /**
   * `beforeToolCall` implementation for the agent loop.
   *
   * Returning `{ block: true, reason }` makes the loop emit an error tool result
   * with that text, which is what the model reads and acts on.
   */
  beforeToolCall: (
    context: {
      assistantMessage: unknown;
      /** The loop's tool call. `id` is carried for correlation, not consulted here. */
      toolCall: { name: string; id?: string };
      args: unknown;
      context: unknown;
    },
    signal?: AbortSignal,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
  /** Answers already given for this session. */
  sessionApprovedTools(): readonly string[];
  /**
   * Switches mode mid-session, for `/approve`.
   *
   * The mode is read per call rather than captured, because tightening it has to
   * take effect on the very next tool call: a gate built with the mode frozen at
   * startup would keep honouring a `full` grant after the user typed
   * `/approve read-only`, which is the opposite of what that command means.
   */
  setMode(mode: ApprovalMode): void;
  mode(): ApprovalMode;
};

/** Questions asked before giving up. Three is enough to notice a typo; more is an interrogation. */
const MAX_ANSWER_ATTEMPTS = 3;

const ANSWERS: Readonly<Record<string, "yes" | "no" | "always">> = {
  y: "yes",
  yes: "yes",
  n: "no",
  no: "no",
  a: "always",
  always: "always",
};

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  const approved = new Set<string>();
  let mode = options.mode;
  const colour = options.colour ?? false;
  const dim = (text: string): string => (colour ? `\x1b[2m${text}\x1b[22m` : text);
  const bold = (text: string): string => (colour ? `\x1b[1m${text}\x1b[22m` : text);

  return {
    sessionApprovedTools: () => [...approved].sort(),
    setMode: (next) => {
      mode = next;
      // Grants never survive a mode change, in either direction. "always allow
      // edit" was consent given under `ask` and is not automatically consent
      // under `full`; and after a round trip through `read-only` the user should
      // be asked again rather than having an old yes remembered.
      approved.clear();
    },
    mode: () => mode,
    async beforeToolCall(context, signal) {
      const toolName = context.toolCall.name;
      const args = (context.args ?? {}) as Record<string, unknown>;
      const verdict = decide({
        toolName,
        args,
        mode,
        sessionApproved: approved.has(toolName),
        insideWorkspace: pathInsideWorkspace(options.workspace, args),
      });
      options.onDecision?.({ toolName, decision: verdict.decision, rule: verdict.rule });

      if (verdict.decision === "allow") {
        return undefined;
      }
      if (verdict.decision === "deny") {
        // The reason goes to the model, so it must say what to do instead of
        // merely refusing; "denied" alone produces a retry with the same call.
        return {
          block: true,
          reason: `${verdict.reason}. Do not retry this call; explain the limitation to the user instead.`,
        };
      }

      const question = `${bold("allow")} ${describeCall(toolName, args)} ${dim("[y/n/a]")}: `;
      options.output.write(`\n${question}`);
      for (let attempt = 0; attempt < MAX_ANSWER_ATTEMPTS; attempt += 1) {
        const line = await readAnswer(options, signal);
        if (line === undefined) {
          // End of input is a refusal, and it is stated as one so a script that
          // ran out of lines can see why nothing happened.
          options.output.write(
            `${dim("(no answer available — refusing)")}\n`,
          );
          return {
            block: true,
            reason: `the user is not present to approve this call; explain what you wanted to do and ask them to run it or re-run with --approve full`,
          };
        }
        const answer = ANSWERS[line.trim().toLowerCase()];
        if (answer === "yes") {
          return undefined;
        }
        if (answer === "always") {
          approved.add(toolName);
          return undefined;
        }
        if (answer === "no") {
          return {
            block: true,
            reason: "the user declined this call",
          };
        }
        const lastAttempt = attempt === MAX_ANSWER_ATTEMPTS - 1;
        options.output.write(
          lastAttempt
            ? `${dim(`answer y, n, or a — "${line.trim()}" is not one of them; giving up`)}\n`
            : `${dim(`answer y, n, or a — "${line.trim()}" is not one of them`)}\n${question}`,
        );
        if (lastAttempt) {
          break;
        }
      }
      return {
        block: true,
        // Says "did not answer", not "declined": a person who walks away and comes
        // back should be able to tell whether they refused something or were never
        // asked again, and the model should not be told the user said no when they
        // said nothing.
        reason: "the user did not answer the approval prompt; they did not decline",
      };
    },
  };
}

/**
 * Waits for one line, resolving `undefined` on end-of-input or abort.
 *
 * The abort race is the reason this is a function: `input.next()` may sit on a
 * readline promise for as long as the user takes, and Ctrl-C has to win without
 * leaving a dangling listener behind.
 */
async function readAnswer(
  options: ApprovalGateOptions,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const active = signal ?? options.signal;
  if (active?.aborted) {
    return undefined;
  }
  const next = options.input.next();
  if (!active) {
    return await next;
  }
  return await new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      active.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => {
      finish(undefined);
    };
    active.addEventListener("abort", onAbort, { once: true });
    void next.then(finish, () => finish(undefined));
  });
}

/** Used by the policy so a `--workspace` escape can never be auto-approved. */
export function pathInsideWorkspace(workspace: Workspace, args: Record<string, unknown>): boolean {
  const raw = args.path ?? args.cwd;
  if (typeof raw !== "string" || !raw.trim()) {
    return true;
  }
  const candidate = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workspace.root, raw);
  return isInsideRoot(workspace.root, candidate);
}

export { decide };
export type { ApprovalMode };
