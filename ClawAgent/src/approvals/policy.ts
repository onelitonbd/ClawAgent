// The approval policy: what a tool call may do without asking.
//
// WHY THIS IS ITS OWN MODULE
//
// A tool call is the only place this agent can change something outside itself,
// so the decision about when to ask is a *policy*, and a policy needs to be
// readable, testable, and free of I/O. Everything here is a pure function of a
// tool name plus its arguments; the prompting lives in ./gate.ts. That split is
// what makes the interesting cases testable — `rm -rf /`, a write to
// `$HOME/.ssh/authorized_keys`, a `bash` call whose `cwd` points out of the
// workspace — without a terminal, a model, or a phone.
//
// Two rules shape the design:
//
// - The gate runs *after* argument validation and *before* execution
//   (`beforeToolCall` in the loop), so the policy sees the same object the tool
//   will. Trusting a re-parse here would mean two parsers that can disagree.
// - Ask-by-default. A tool that can write is a tool that can destroy a person's
//   only copy of something. `--yes` exists because the alternative is a user who
//   approves reflexively, which is worse than asking.

import { countLines, lineCount } from "../util/lines.ts";

/** What the policy decided about one call. */
export type ApprovalDecision = "allow" | "ask" | "deny";

/** User-selectable modes for `agent --approve`. */
export type ApprovalMode = "read-only" | "workspace" | "full" | "ask";

export type ToolCallDescription = {
  toolName: string;
  args: Record<string, unknown>;
};

/**
 * Commands that should never run unattended on a phone.
 *
 * Deliberately a small, explicit list of *destructive shapes* rather than an
 * attempt at a shell sandbox: the real defence is that `bash` never runs a shell,
 * so a pipe or `$(...)` cannot smuggle anything past this check. What is left to
 * catch is a directly-invoked destroyer (`rm -rf /`), and that is cheap to name.
 */
const DESTRUCTIVE: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)*(-[a-z]*\s+)*\/(\s|$)/iu, reason: "removes from the filesystem root" },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r/iu, reason: "recursive force delete" },
  { pattern: /\bmkfs(\.|\s)/iu, reason: "formats a filesystem" },
  { pattern: /\bdd\b[^|]*\bof=\/dev\//iu, reason: "writes raw to a device" },
  { pattern: /:\(\)\s*\{/u, reason: "fork bomb" },
  { pattern: /\bchmod\s+(-[a-z]+\s+)*777\s+\//iu, reason: "world-writable from the root" },
  { pattern: /\bchown\s+(-[a-z]+\s+)*\S+\s+\//iu, reason: "changes ownership from the root" },
  { pattern: /\bdangerously-ignore-file-locking\b/iu, reason: "bypasses a package manager lock" },
];

/** Files whose contents are either secrets or the ability to log in. */
const SENSITIVE_PATHS: readonly RegExp[] = [
  /(^|\/)\.ssh(\/|$)/u,
  /(^|\/)\.gnupg(\/|$)/u,
  /(^|\/)\.aws(\/|$)/u,
  /(^|\/)authorized_keys$/u,
  /(^|\/)id_(rsa|ed25519|ecdsa)$/u,
  /(^|\/)\.netrc$/u,
  /(^|\/)\.npmrc$/u,
  /(^|\/)credentials(\.json)?$/u,
  /(^|\/)\.termux\/(auth|api-keys?)(\/|$)/u,
];

/** Always-ask tools per mode. `deny` for read-only is handled by the caller. */
const MUTATING_TOOLS: readonly string[] = ["write", "edit", "bash"];

export type PolicyInput = ToolCallDescription & {
  mode: ApprovalMode;
  /** True when the user already said "allow everything for this session". */
  sessionApproved: boolean;
  /** True when the path argument, if any, stays inside the workspace. */
  insideWorkspace?: boolean;
};

export type PolicyVerdict = {
  decision: ApprovalDecision;
  /** Shown in the prompt and, for a deny, returned to the model. */
  reason: string;
  /** The rule that fired, for `--explain` and for tests. */
  rule: string;
};

/**
 * Decides one tool call.
 *
 * Order matters, and it is not the obvious one: destructive checks come *first*
 * so that `--yes` cannot waive them. A flag that means "stop asking" must not
 * mean "also allow wiping the device", because the second is what people mean
 * when they reach for the first in a hurry.
 */
export function decide(input: PolicyInput): PolicyVerdict {
  const { toolName, args, mode } = input;

  if (mode === "read-only" && MUTATING_TOOLS.includes(toolName)) {
    return {
      decision: "deny",
      reason: `${toolName} is not available in read-only mode`,
      rule: "mode:read-only",
    };
  }

  const command = typeof args.command === "string" ? args.command : undefined;
  if (command) {
    for (const { pattern, reason } of DESTRUCTIVE) {
      if (pattern.test(command)) {
        return {
          decision: "deny",
          reason: `refused: ${reason}`,
          rule: "destructive-command",
        };
      }
    }
  }

  const pathArgument = pathLikeArgument(args);
  if (pathArgument && isSensitive(pathArgument)) {
    return {
      decision: "ask",
      reason: `${toolName} on ${pathArgument} touches a credential or key file`,
      rule: "sensitive-path",
    };
  }

  if (mode === "full") {
    return { decision: "allow", reason: "full access mode", rule: "mode:full" };
  }
  if (input.sessionApproved) {
    return { decision: "allow", reason: "approved for this session", rule: "session-approved" };
  }

  if (!MUTATING_TOOLS.includes(toolName)) {
    return { decision: "allow", reason: "read-only tool", rule: "tool:read-only" };
  }

  if (mode === "workspace" && toolName !== "bash" && input.insideWorkspace !== false) {
    return {
      decision: "allow",
      reason: "inside the workspace",
      rule: "mode:workspace",
    };
  }

  // `bash` is refused-by-default even in workspace mode: the tool's own path
  // checks cannot constrain what the program it starts decides to do.
  if (mode === "workspace" && toolName === "bash") {
    const reason = command
      ? `run \`${firstWords(command)}\`?`
      : "run this command?";
    return { decision: "ask", reason, rule: "mode:workspace:bash" };
  }

  return {
    decision: "ask",
    reason: `about to ${describeCall(toolName, args)}`,
    rule: "mode:ask",
  };
}

function firstWords(command: string): string {
  const words = command.trim().split(/\s+/u).slice(0, 3);
  return words.join(" ");
}

/** Human sentence for the prompt. Reads like a diff summary, not a JSON dump. */
export function describeCall(toolName: string, args: Record<string, unknown>): string {
  const target = pathLikeArgument(args);
  switch (toolName) {
    case "write": {
      const content = typeof args.content === "string" ? args.content : "";
      return `create or replace ${target ?? "a file"} (${lineCount(countLines(content))})`;
    }
    case "edit": {
      const edits = Array.isArray(args.edits) ? args.edits.length : 0;
      return `edit ${target ?? "a file"} (${edits} replacement${edits === 1 ? "" : "s"})`;
    }
    case "bash":
      return `run \`${typeof args.command === "string" ? firstWords(args.command) : "a command"}\``;
    default:
      return `call ${toolName}${target ? ` on ${target}` : ""}`;
  }
}

/** Any argument that names a place on disk. */
export function pathLikeArgument(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "cwd", "notebookPath"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function isSensitive(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/");
  return SENSITIVE_PATHS.some((pattern) => pattern.test(normalized));
}

/** For `--approve` parsing and `agent --help`. */
export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "workspace", "full", "read-only"];

export function parseApprovalMode(value: string | undefined): ApprovalMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  // Accept the shapes people type, because a typo in a security flag must not
  // silently become the *more permissive* mode.
  const aliases: Record<string, ApprovalMode> = {
    ask: "ask",
    prompt: "ask",
    workspace: "workspace",
    "auto-edit": "workspace",
    autoedit: "workspace",
    full: "full",
    yolo: "full",
    "no-ask": "full",
    "read-only": "read-only",
    readonly: "read-only",
    plan: "read-only",
  };
  return aliases[trimmed];
}
