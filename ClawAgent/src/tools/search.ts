// glob / grep — the two tools a model uses to find anything, and the two most
// likely to melt a phone.
//
// There is no ripgrep on Termux by default and shelling out to `find`/`grep`
// would make behaviour depend on what happens to be installed. So the walk is
// here, bounded three ways, because the cost of an unbounded walk on a device
// with a few hundred thousand inodes and a thermal limit is not a slow command
// but a frozen UI:
//   - directories in DEFAULT_SKIP_DIRECTORIES are not entered;
//   - files above DEFAULT_OUTPUT_CAPS.fileBytes are not searched;
//   - the result list stops at a cap and says that it stopped.
//
// Results are sorted by path so the same tree gives the same answer twice. A
// model that sees `src/a.ts` on one run and `src/b.ts` on the next starts
// hedging, and nondeterminism is the one thing a tool layer must not add.

import { opendirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@openclaw/agent-core";
import { tryDecodeUtf8 } from "../util/utf8.ts";
import { matchesGlob } from "./glob-match.ts";
import {
  DEFAULT_OUTPUT_CAPS,
  DEFAULT_SKIP_DIRECTORIES,
  fileStat,
  resolveToolPath,
  type Workspace,
} from "./workspace.ts";

const SKIP = new Set(DEFAULT_SKIP_DIRECTORIES);

export type WalkEntry = {
  /** Path relative to the walk root, with forward slashes. */
  relative: string;
  absolute: string;
  size: number;
};

export type WalkOptions = {
  root: string;
  /** Refuse to descend into a directory whose relative path matches. */
  skipDirectories?: ReadonlySet<string>;
  maxEntries?: number;
  maxDepth?: number;
  /** Include dotfiles and dot directories. Off by default. */
  includeHidden?: boolean;
  /** Only files at or below this size are yielded. */
  maxFileBytes?: number;
};

export type WalkResult = {
  entries: WalkEntry[];
  /** True when a cap stopped the walk, so callers can say so instead of looking complete. */
  truncated: boolean;
  directoriesSkipped: number;
};

/**
 * Depth-first walk over plain files.
 *
 * Uses `opendirSync` + `readSync` rather than `readdirSync(withFileTypes)`
 * everywhere so a symlinked directory is reported as a symlink and skipped
 * instead of being followed into a cycle. Symlink loops inside a workspace are
 * easy to create by accident (`ln -s .. parent`) and a walker that follows them
 * is a hang.
 */
export function walkFiles(options: WalkOptions): WalkResult {
  const skip = options.skipDirectories ?? SKIP;
  const maxEntries = options.maxEntries ?? 20000;
  const maxDepth = options.maxDepth ?? 24;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_OUTPUT_CAPS.fileBytes;
  const includeHidden = options.includeHidden ?? false;
  const entries: WalkEntry[] = [];
  let truncated = false;
  let directoriesSkipped = 0;

  const visit = (absolute: string, relative: string, depth: number): void => {
    if (truncated) {
      return;
    }
    let handle;
    try {
      handle = opendirSync(absolute);
    } catch {
      return;
    }
    try {
      for (;;) {
        let entry: Dirent | null;
        try {
          entry = handle.readSync();
        } catch {
          break;
        }
        if (entry === null) {
          break;
        }
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const childAbsolute = path.join(absolute, entry.name);
        if (entry.isDirectory()) {
          if (skip.has(entry.name) || (includeHidden === false && entry.name.startsWith("."))) {
            directoriesSkipped += 1;
            continue;
          }
          if (depth + 1 > maxDepth) {
            continue;
          }
          visit(childAbsolute, childRelative, depth + 1);
          if (truncated) {
            return;
          }
          continue;
        }
        if (!entry.isFile()) {
          // Symlinks, sockets, FIFOs, devices: none of them are text to grep.
          continue;
        }
        if (!includeHidden && entry.name.startsWith(".")) {
          continue;
        }
        const size = fileStat(childAbsolute)?.size;
        if (size === undefined) {
          continue;
        }
        if (size > maxFileBytes) {
          continue;
        }
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        entries.push({ relative: childRelative, absolute: childAbsolute, size });
      }
    } finally {
      try {
        handle.closeSync();
      } catch {
        // The descriptor is best-effort; a closed directory is not a tool error.
      }
    }
  };

  visit(options.root, "", 0);
  entries.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
  return { entries, truncated, directoriesSkipped };
}

const GlobParams = Type.Object(
  {
    pattern: Type.String({ description: "Glob, e.g. src/**/*.ts, *.json, test/*/*.test.ts" }),
    path: Type.Optional(Type.String({ description: "Directory to search; defaults to the workspace root" })),
    includeHidden: Type.Optional(Type.Boolean({ description: "Also match dotfiles" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
  },
  { additionalProperties: false },
);

const GrepParams = Type.Object(
  {
    pattern: Type.String({ description: "JavaScript regular expression to search for" }),
    path: Type.Optional(Type.String({ description: "File or directory; defaults to the workspace root" })),
    glob: Type.Optional(Type.String({ description: "Only search files matching this glob" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive match" })),
    context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Lines to show around each hit" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Max matching lines" })),
  },
  { additionalProperties: false },
);

export type SearchToolOptions = { workspace: Workspace };

export function createGlobTool(options: SearchToolOptions): AgentTool<typeof GlobParams> {
  return {
    label: "Glob",
    name: "glob",
    description:
      "Find files by glob pattern, relative to the workspace. Skips .git and node_modules. Returns sorted paths.",
    parameters: GlobParams,
    execute: async (_id, params: Static<typeof GlobParams>): Promise<AgentToolResult<unknown>> => {
      const root = params.path
        ? resolveToolPath(options.workspace, params.path, "search directory")
        : options.workspace.root;
      const limit = params.limit ?? DEFAULT_OUTPUT_CAPS.globResults;
      const walked = walkFiles({
        root,
        maxEntries: limit + 1,
        includeHidden: params.includeHidden === true,
      });
      const matched = walked.entries.filter((entry) => matchesGlob(entry.relative, params.pattern));
      const shown = matched.slice(0, limit);
      const notes: string[] = [];
      if (matched.length > shown.length) {
        notes.push(`${matched.length - shown.length} more matches`);
      }
      if (walked.truncated) {
        notes.push(`directory walk stopped after ${limit + 1} files; narrow the pattern`);
      }
      const body = shown.map((entry) => `${entry.relative}\t${entry.size}`).join("\n");
      return {
        content: [{ type: "text", text: body ? `${body}${notes.length ? `\n\n[${notes.join("; ")}]` : ""}` : "no files matched" }],
        details: { pattern: params.pattern, root, matches: matched.length, shown: shown.length },
      };
    },
  };
}

export function createGrepTool(options: SearchToolOptions): AgentTool<typeof GrepParams> {
  return {
    label: "Grep",
    name: "grep",
    description:
      "Search file contents with a regular expression. Optional glob filter and surrounding context lines. Skips .git, node_modules, and files over 2 MiB.",
    parameters: GrepParams,
    execute: async (_id, params: Static<typeof GrepParams>): Promise<AgentToolResult<unknown>> => {
      const expression = buildExpression(params);
      const limit = params.limit ?? DEFAULT_OUTPUT_CAPS.grepMatches;
      const context = params.context ?? 0;
      const targets = resolveGrepTargets(options.workspace, params);

      const hits: string[] = [];
      let matchedLines = 0;
      let filesWithMatches = 0;
      let truncated = false;
      for (const file of targets.entries) {
        if (hits.length >= limit) {
          truncated = true;
          break;
        }
        const lines = readLines(file.absolute);
        if (lines === undefined) {
          continue;
        }
        const fileHits: string[] = [];
        let shownThrough = 0;
        for (let index = 0; index < lines.length; index += 1) {
          if (!expression.test(lines[index] ?? "")) {
            continue;
          }
          // Count every match, shown or not: "12 matching lines" followed by 4 of
          // them is honest, "4 matching lines" is a lie about the file.
          matchedLines += 1;
          const from = Math.max(0, index - context);
          const to = Math.min(lines.length, index + context + 1);
          if (fileHits.length > 0 && from > shownThrough) {
            fileHits.push(`${file.relative}-`);
          }
          for (let at = Math.max(from, shownThrough); at < to; at += 1) {
            fileHits.push(`${file.relative}:${at + 1}${at === index ? ":" : "-"}${lines[at] ?? ""}`);
          }
          shownThrough = Math.max(shownThrough, to);
        }
        if (fileHits.length === 0) {
          continue;
        }
        filesWithMatches += 1;
        const remaining = limit - hits.length;
        if (fileHits.length > remaining) {
          hits.push(...fileHits.slice(0, remaining));
          truncated = true;
          break;
        }
        hits.push(...fileHits);
      }

      if (!truncated && targets.truncated) {
        truncated = true;
      }
      const suffix = truncated
        ? `\n\n[stopped at ${limit} matching lines${targets.truncated ? "; the file list itself was capped" : ""}]`
        : "";
      const head = matchedLines === 0 ? "no matches" : `${matchedLines} matching line${matchedLines === 1 ? "" : "s"} in ${filesWithMatches} file${filesWithMatches === 1 ? "" : "s"}`;
      return {
        content: [{ type: "text", text: hits.length === 0 ? head : `${head}\n\n${hits.join("\n")}${suffix}` }],
        details: { pattern: params.pattern, matchedLines, filesWithMatches, shown: hits.length, truncated },
      };
    },
  };
}

function buildExpression(params: Static<typeof GrepParams>): RegExp {
  try {
    // No `g` flag: `test` on a global regex advances lastIndex and makes the
    // next line start from there, which reads as a search that loses matches.
    return new RegExp(params.pattern, params.ignoreCase === true ? "iu" : "u");
  } catch (error) {
    throw new Error(
      `invalid regular expression ${params.pattern}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }
}

type Targets = { entries: WalkEntry[]; truncated: boolean };

function resolveGrepTargets(workspace: Workspace, params: Static<typeof GrepParams>): Targets {
  const target = params.path ? resolveToolPath(workspace, params.path, "search path") : workspace.root;
  const stat = fileStat(target);
  // Captured before the closures below: `params.glob` is narrowed by the check
  // here, and TypeScript forgets that inside a callback.
  const glob = params.glob;
  if (stat?.isFile()) {
    const entry = { relative: path.basename(target), absolute: target, size: stat.size };
    return {
      entries: glob && !matchesGlob(path.basename(target), glob) ? [] : [entry],
      truncated: false,
    };
  }
  const root = stat?.isDirectory() ? target : workspace.root;
  const walked = walkFiles({ root, maxEntries: 20000 });
  if (!glob) {
    return { entries: walked.entries, truncated: walked.truncated };
  }
  return {
    entries: walked.entries.filter((entry) => matchesGlob(entry.relative, glob)),
    truncated: walked.truncated,
  };
}

/** Returns undefined for non-text content, so a binary file never produces a hit. */
function readLines(absolute: string): string[] | undefined {
  let buffer;
  try {
    buffer = readFileSync(absolute);
  } catch {
    return undefined;
  }
  const text = tryDecodeUtf8(buffer);
  if (text === undefined) {
    return undefined;
  }
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}
