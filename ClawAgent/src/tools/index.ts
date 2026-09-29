// The workspace tool set, as one call.
//
// Tools are constructed per run rather than at module scope, because each one
// captures the workspace boundary and the caps it enforces. A module-level
// singleton would mean the first `--workspace` seen by a process wins, which is
// exactly the kind of latent state that turns into a wrong-path write later.

import { createBashTool, type BashToolOptions } from "./bash.ts";
import { createEditTool, createReadTool, createWriteTool, type FileToolOptions } from "./file-tools.ts";
import { createGlobTool, createGrepTool } from "./search.ts";
import { createWorkspace, type PathPolicy, type Workspace } from "./workspace.ts";
import type { AgentTool } from "@openclaw/agent-core";

export type WorkspaceToolName = "read" | "write" | "edit" | "glob" | "grep" | "bash";

/** Every tool name this set can produce, in the order it hands them to the model. */
export const WORKSPACE_TOOL_NAMES: readonly WorkspaceToolName[] = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "bash",
];

export type BuildToolOptions = {
  /** Directory tools are confined to. Defaults to the process working directory. */
  root?: string;
  policy?: PathPolicy;
  /** Subset to build. Omitted means all six. */
  only?: readonly WorkspaceToolName[];
  /** Read-only mode: the mutating tools are not created at all, so the model never sees them. */
  readOnly?: boolean;
  env?: NodeJS.ProcessEnv;
  defaultBashTimeoutMs?: number;
  maxOutputBytes?: number;
};

export type BuiltTools = {
  workspace: Workspace;
  tools: AgentTool[];
};

/**
 * Builds the tool set for one run.
 *
 * `readOnly` removes tools rather than making them fail. A tool the model can
 * see but not use is a tool the model will spend a turn calling, and the
 * resulting error teaches it nothing about what this run is for.
 */
export function buildWorkspaceTools(options: BuildToolOptions = {}): BuiltTools {
  const workspace = createWorkspace({
    ...(options.root ? { root: options.root } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
  });
  const fileOptions: FileToolOptions = { workspace };
  const bashOptions: BashToolOptions = {
    workspace,
    ...(options.env ? { env: options.env } : {}),
    ...(options.defaultBashTimeoutMs ? { defaultTimeoutMs: options.defaultBashTimeoutMs } : {}),
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
  };
  const readOnly = options.readOnly === true;
  const factory: Record<WorkspaceToolName, () => AgentTool> = {
    read: () => createReadTool(fileOptions) as AgentTool,
    write: () => createWriteTool(fileOptions) as AgentTool,
    edit: () => createEditTool(fileOptions) as AgentTool,
    glob: () => createGlobTool({ workspace }) as AgentTool,
    grep: () => createGrepTool({ workspace }) as AgentTool,
    bash: () => createBashTool(bashOptions) as AgentTool,
  };
  const wanted = options.only ?? WORKSPACE_TOOL_NAMES;
  const tools: AgentTool[] = [];
  for (const name of wanted) {
    if (!WORKSPACE_TOOL_NAMES.includes(name)) {
      throw new TypeError(`unknown tool: ${String(name)}`);
    }
    // Mutating tools are dropped here rather than refused inside `execute`, so a
    // read-only run never advertises them to the model at all.
    if (readOnly && MUTATING_TOOLS.includes(name)) {
      continue;
    }
    tools.push(factory[name]());
  }
  return { workspace, tools };
}

/** Names that change something, and so are the ones an approval gate exists for. */
export const MUTATING_TOOLS: readonly WorkspaceToolName[] = ["write", "edit", "bash"];

export { createBashTool, resolveExecutable } from "./bash.ts";
export { createEditTool, createReadTool, createWriteTool, formatBytes } from "./file-tools.ts";
export { createGlobTool, createGrepTool, walkFiles } from "./search.ts";
export {
  createWorkspace,
  isInsideRoot,
  resolveToolPath,
  WorkspacePathError,
  DEFAULT_OUTPUT_CAPS,
  DEFAULT_SKIP_DIRECTORIES,
} from "./workspace.ts";
export type { PathPolicy, Workspace, WorkspaceOptions } from "./workspace.ts";
