// The approval decision table.
//
// These are pure-function tests with no terminal, no model, and no device, which
// is the point of keeping the policy separate from the gate: every case below is
// a case where being wrong means either destroying something the user cares about
// or training them to approve without reading.

import { describe, expect, it } from "vitest";
import {
  APPROVAL_MODES,
  decide,
  describeCall,
  isSensitive,
  parseApprovalMode,
} from "./policy.ts";

const decideFor = (
  toolName: string,
  args: Record<string, unknown>,
  mode: (typeof APPROVAL_MODES)[number],
  extra: { sessionApproved?: boolean; insideWorkspace?: boolean } = {},
) =>
  decide({
    toolName,
    args,
    mode,
    sessionApproved: extra.sessionApproved ?? false,
    ...(extra.insideWorkspace === undefined ? {} : { insideWorkspace: extra.insideWorkspace }),
  });

describe("decide", () => {
  it("never asks to read", () => {
    for (const mode of APPROVAL_MODES) {
      expect(decideFor("read", { path: "a.ts" }, mode).decision, `mode ${mode}`).toBe("allow");
    }
  });

  it("allows in-workspace writes without asking in workspace mode", () => {
    expect(decideFor("write", { path: "src/a.ts" }, "workspace").decision).toBe("allow");
    expect(decideFor("edit", { path: "src/a.ts", edits: [] }, "workspace").rule).toBe("mode:workspace");
  });

  it("still asks for bash in workspace mode", () => {
    // A program can do anything the user can, so "editing inside the workspace"
    // says nothing at all about `bash`.
    const verdict = decideFor("bash", { command: "ls" }, "workspace");
    expect(verdict.decision).toBe("ask");
    expect(verdict.rule).toBe("mode:workspace:bash");
  });

  it("refuses a workspace write that escapes the workspace", () => {
    const verdict = decideFor("write", { path: "../outside.txt" }, "workspace", {
      insideWorkspace: false,
    });
    expect(verdict.decision).toBe("ask");
  });

  it("asks for everything in ask mode", () => {
    for (const tool of ["write", "edit", "bash"] as const) {
      expect(decideFor(tool, { path: "a.ts", command: "ls" }, "ask").decision, tool).toBe("ask");
    }
  });

  it("denies mutating tools in read-only mode, including with --yes", () => {
    // `--yes` maps to `full`; read-only is the mode a user picks to be safe, so a
    // second flag must never be able to override it.
    for (const tool of ["write", "edit", "bash"] as const) {
      const verdict = decideFor(tool, { path: "a.ts", command: "ls" }, "read-only");
      expect(verdict.decision, tool).toBe("deny");
    }
    expect(decideFor("read", { path: "a.ts" }, "read-only").decision).toBe("allow");
  });

  it("honours a session grant only for the tool it covered", () => {
    expect(decideFor("write", { path: "a.ts" }, "ask", { sessionApproved: true }).decision).toBe("allow");
    expect(decideFor("edit", { path: "a.ts" }, "ask", { sessionApproved: false }).decision).toBe("ask");
  });

  it.each([
    ["rm -rf /", "removes from the filesystem root"],
    ["rm -fr /tmp/x", "recursive force delete"],
    ["sudo rm -rf / --no-preserve-root", undefined],
    ["mkfs.ext4 /dev/sda1", "formats a filesystem"],
    ["dd if=/dev/zero of=/dev/sda", "writes raw to a device"],
    [":(){ :|:& };:", "fork bomb"],
    ["chmod -R 777 /", "world-writable from the root"],
    ["chown -R nobody /", "changes ownership from the root"],
  ])("refuses %j even in full mode", (command, reason) => {
    const verdict = decideFor("bash", { command }, "full");
    expect(verdict.decision).toBe("deny");
    if (reason) {
      expect(verdict.reason).toContain(reason);
    }
  });

  it("does not refuse an ordinary rm", () => {
    // Over-refusal is a real cost: a policy that blocks `rm build/out.txt` gets
    // worked around by the user, and then nothing is approved deliberately.
    const verdict = decideFor("bash", { command: "rm build/out.txt" }, "full");
    expect(verdict.decision).toBe("allow");
  });

  it("asks about credential and key files even in full mode", () => {
    for (const path of [
      "~/.ssh/id_ed25519",
      "/home/u/.ssh/authorized_keys",
      ".gnupg/secring.gpg",
      "credentials.json",
      "src/../../.npmrc",
    ]) {
      const verdict = decideFor("write", { path }, "full");
      expect(verdict.decision, path).toBe("ask");
      expect(verdict.rule, path).toBe("sensitive-path");
    }
  });

  it("classifies sensitive paths on the path argument, not on prose", () => {
    expect(isSensitive("~/.ssh/id_rsa")).toBe(true);
    // A file that merely mentions ssh in its name is not the key.
    expect(isSensitive("docs/ssh-notes.md")).toBe(false);
    expect(isSensitive("src/ssh-client.ts")).toBe(false);
  });

  it("explains a refusal with the target named", () => {
    expect(describeCall("write", { path: "a.ts", content: "x\ny\n" })).toContain("2 lines");
    expect(describeCall("edit", { path: "a.ts", edits: [1, 2] })).toContain("2 replacements");
    expect(describeCall("bash", { command: "git commit -m msg" })).toContain("git commit -m");
    expect(describeCall("search", { query: "x" })).toContain("call search");
  });
});

describe("parseApprovalMode", () => {
  it("accepts the shapes people type", () => {
    expect(parseApprovalMode("ASK")).toBe("ask");
    expect(parseApprovalMode(" prompt ")).toBe("ask");
    expect(parseApprovalMode("auto-edit")).toBe("workspace");
    expect(parseApprovalMode("yolo")).toBe("full");
    expect(parseApprovalMode("readonly")).toBe("read-only");
    expect(parseApprovalMode("plan")).toBe("read-only");
  });

  it("returns undefined for anything else, so a typo cannot become the permissive mode", () => {
    expect(parseApprovalMode("fulll")).toBeUndefined();
    expect(parseApprovalMode("")).toBeUndefined();
    expect(parseApprovalMode("no-questions-asked")).toBeUndefined();
  });
});
