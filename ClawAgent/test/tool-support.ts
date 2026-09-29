// Shared fixtures for the tool tests.
//
// The tools all take a workspace, so the interesting fixture is a real directory
// tree on a real filesystem: `realpath`, `chmod`, symlinks, and `rename` are the
// parts under test, and mocking them would test nothing. `mkdtemp` in the OS
// temp directory is what the repo's other tests do, and it keeps the tree out of
// the checkout even when a test fails halfway.
//
// One trap this avoids: on macOS and some Android mounts the temp directory is
// itself a symlink, so tests compare against `fs.realpathSync(tmp)` rather than
// the string `mkdtempSync` returned. A tool that resolves paths correctly looks
// broken otherwise.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspace, type PathPolicy, type Workspace } from "../src/tools/workspace.ts";

/** A second, genuinely outside tree, for symlink-escape tests. */
export function outsideTree(): { root: string; cleanup(): void } {
  const created = mkdtempSync(path.join(tmpdir(), "clawagent-outside-"));
  return {
    root: realpathSync(created),
    cleanup() {
      rmSync(created, { recursive: true, force: true });
    },
  };
}

export type ToolFixture = {
  /** Symlink-free root, i.e. what the workspace will report. */
  root: string;
  write(relative: string, contents: string): string;
  mkdir(relative: string): string;
  symlink(target: string, relative: string, kind?: "dir" | "file"): void;
  read(relative: string): string;
  exists(relative: string): boolean;
  workspace(options?: { policy?: PathPolicy }): Workspace;
  cleanup(): void;
};

export function withWorkspace(): ToolFixture {
  const created = mkdtempSync(path.join(tmpdir(), "clawagent-tools-"));
  const root = realpathSync(created);
  const at = (relative: string): string => path.join(root, relative);
  return {
    root,
    write(relative, contents) {
      const target = at(relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents, "utf8");
      return target;
    },
    mkdir(relative) {
      const target = at(relative);
      mkdirSync(target, { recursive: true });
      return target;
    },
    symlink(target, relative, kind = "dir") {
      mkdirSync(path.dirname(at(relative)), { recursive: true });
      symlinkSync(target, at(relative), kind);
    },
    read(relative) {
      return readFileSync(at(relative), "utf8");
    },
    exists(relative) {
      return existsSync(at(relative));
    },
    workspace(options) {
      return createWorkspace({ root, ...(options?.policy ? { policy: options.policy } : {}) });
    },
    cleanup() {
      rmSync(created, { recursive: true, force: true });
    },
  };
}

/**
 * Runs a tool's `execute` and returns its text content, which is what a model
 * sees. Deliberately no trimming: line-number padding and empty results are part
 * of the contract, and a helper that eats leading whitespace hides a tool that
 * forgot to pad.
 */
/**
 * Any tool's `execute`, typed loosely on purpose.
 *
 * `(...args: never[])` is the shape that accepts every `AgentTool` without
 * re-declaring its generics here: a helper restating the signature would drift
 * the first time a tool gains a parameter, and the drift would show up as a
 * type error in the *tests*, not in the tool.
 */
type ToolExecute = (
  id: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<{ content: readonly unknown[] }>;

type RunnableTool = {
  /**
   * `never` parameters, because that is the only signature every real
   * `AgentTool` is assignable to: its `execute` takes a validated, tool-specific
   * argument object, and a helper here must not have to know each one. The cost
   * is one cast at the call site below, which is the place that actually knows.
   */
  execute: (...args: never[]) => Promise<{ content: readonly unknown[] }>;
};

export async function runTool(
  tool: RunnableTool,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const execute = tool.execute as unknown as ToolExecute;
  const result = await execute("test-call", params, signal);
  const parts = result.content as ReadonlyArray<{ type?: string; text?: string }>;
  // An image part is described rather than dropped, so a test that pipes a
  // vision-capable tool's output into an assertion still sees that it happened.
  return parts.map((part) => (part.type === "image" ? "[image]" : (part.text ?? ""))).join("");
}
