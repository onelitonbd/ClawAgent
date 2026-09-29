// read / write / edit — the three tools that make this an agent rather than a
// chat client, plus the walking search tools in ./search.ts.
//
// Design rules, all of them earned on a phone:
//
// - Every tool returns text a model can act on, and *fails* by throwing. The
//   agent loop turns a throw into an error tool result, which is what gives the
//   model a chance to correct itself; a `content` that says "error" in prose is
//   something models frequently re-read as success.
// - Output is capped and the cap is announced. A silent cut tells the model its
//   answer was complete; a truncated marker tells it to page with `offset`.
// - Reads are line-numbered, because `edit` quotes exact text and a model that
//   cannot see line boundaries invents whitespace.
// - Writes are atomic (`tmp` + `rename`) and preserve the existing mode. A
//   half-written file on a phone that just lost power or ran out of `/data`
//   space is worse than no write at all, and dropping `0700` off a credentials
//   file while "just editing" it is how a rebuild like this earns a CVE.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { countLines, lineCount } from "../util/lines.ts";
import { decodeUtf8Strict, looksBinary } from "../util/utf8.ts";
import type { AgentTool, AgentToolResult } from "@openclaw/agent-core";
import {
  DEFAULT_OUTPUT_CAPS,
  fileStat,
  resolveToolPath,
  WorkspacePathError,
  type Workspace,
} from "./workspace.ts";

/** Text-only result, matching the shape the loop expects. */
function textResult(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

const READ_LINES_CAP = DEFAULT_OUTPUT_CAPS.readLines;
/** Beyond this many matches the exact count stops being useful to a model. */
const COUNT_CAP = 100;
const READ_BYTES_CAP = DEFAULT_OUTPUT_CAPS.readBytes;

const ReadParams = Type.Object(
  {
    path: Type.String({ description: "File to read, relative to the workspace root" }),
    offset: Type.Optional(
      Type.Integer({ minimum: 1, description: "1-based line to start from (default 1)" }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 5000, description: `Max lines to return (default ${READ_LINES_CAP})` }),
    ),
  },
  { additionalProperties: false },
);

const WriteParams = Type.Object(
  {
    path: Type.String({ description: "File to create or replace" }),
    content: Type.String({ description: "Full new contents" }),
  },
  { additionalProperties: false },
);

const EditParams = Type.Object(
  {
    path: Type.String({ description: "File to edit" }),
    edits: Type.Array(
      Type.Object(
        {
          oldText: Type.String({ description: "Exact text to replace, copied from a read" }),
          newText: Type.String({ description: "Replacement text" }),
          all: Type.Optional(
            Type.Boolean({ description: "Replace every occurrence instead of requiring uniqueness" }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, description: "Edits applied in order; all must match or nothing is written" },
    ),
  },
  { additionalProperties: false },
);

export type FileToolOptions = {
  workspace: Workspace;
  /** Injected for tests; defaults to the real clock-free `node:fs` calls. */
  now?: () => number;
};

/**
 * Reads a text file with line numbers.
 *
 * A binary file is refused rather than streamed: a base64 blob pasted into a
 * transcript costs real money per token on a metered connection and tells the
 * model nothing.
 */
export function createReadTool(options: FileToolOptions): AgentTool<typeof ReadParams> {
  return {
    label: "Read",
    name: "read",
    description:
      "Read a UTF-8 text file and return it with 1-based line numbers. Use offset/limit for large files; reads are capped. Refuses binary files.",
    parameters: ReadParams,
    execute: async (_id, params: Static<typeof ReadParams>): Promise<AgentToolResult<unknown>> => {
      const target = resolveToolPath(options.workspace, params.path, "read path");
      const stat = fileStat(target);
      if (!stat) {
        throw new Error(`no such file: ${target}`);
      }
      if (stat.isDirectory()) {
        throw new Error(`${target} is a directory; use glob to list it`);
      }
      if (stat.size > DEFAULT_OUTPUT_CAPS.fileBytes) {
        throw new Error(
          `${target} is ${formatBytes(stat.size)}, over the ${formatBytes(DEFAULT_OUTPUT_CAPS.fileBytes)} limit for reads; use grep to search it or bash with head/tail`,
        );
      }
      const buffer = readFileSync(target);
      if (looksBinary(buffer)) {
        throw new Error(`${target} looks like a binary file (NUL byte in the first 8 KiB)`);
      }
      const text = decodeUtf8Strict(buffer);
      const lines = text.split("\n");
      const start = Math.max(1, params.offset ?? 1);
      const cap = Math.min(params.limit ?? READ_LINES_CAP, READ_LINES_CAP);
      const slice = lines.slice(start - 1, start - 1 + cap);
      const rendered: string[] = [];
      let bytes = 0;
      let truncatedByBytes = false;
      for (const [index, line] of slice.entries()) {
        const row = `${String(start + index).padStart(6)}\t${line}`;
        bytes += Buffer.byteLength(row, "utf8") + 1;
        if (bytes > READ_BYTES_CAP) {
          truncatedByBytes = true;
          break;
        }
        rendered.push(row);
      }
      const consumed = start - 1 + rendered.length;
      const notes: string[] = [];
      if (truncatedByBytes) {
        notes.push(`output capped at ${formatBytes(READ_BYTES_CAP)}`);
      }
      if (consumed < lines.length) {
        notes.push(`${lines.length - consumed} more lines; continue with offset ${consumed + 1}`);
      }
      const body = rendered.join("\n");
      return textResult(notes.length === 0 ? body : `${body}\n\n[${notes.join("; ")}]`, {
        path: target,
        totalLines: lines.length,
        firstLine: start,
        returnedLines: rendered.length,
      });
    },
  };
}

/** Creates or replaces a file. Parents are created, because `write` to a new subdirectory is not an error worth a round trip. */
export function createWriteTool(options: FileToolOptions): AgentTool<typeof WriteParams> {
  return {
    label: "Write",
    name: "write",
    description: "Create or replace a text file with the given contents. Creates parent directories.",
    parameters: WriteParams,
    execute: async (_id, params: Static<typeof WriteParams>): Promise<AgentToolResult<unknown>> => {
      const target = resolveToolPath(options.workspace, params.path, "write path");
      const existed = existsSync(target);
      if (existed && fileStat(target)?.isDirectory()) {
        throw new Error(`${target} is a directory`);
      }
      const previousMode = existingMode(target);
      mkdirSync(path.dirname(target), { recursive: true });
      atomicWrite(target, params.content, previousMode);
      return textResult(
        `${existed ? "updated" : "created"} ${relativeTo(options.workspace.root, target)} (${lineCount(countLines(params.content))}, ${formatBytes(Buffer.byteLength(params.content, "utf8"))})`,
        { path: target, existed, bytes: Buffer.byteLength(params.content, "utf8") },
      );
    },
  };
}

/**
 * Applies exact-text edits atomically.
 *
 * Every edit must match before anything is written. Partial application is the
 * failure mode that leaves a file syntactically broken and a model convinced it
 * already fixed it.
 */
export function createEditTool(options: FileToolOptions): AgentTool<typeof EditParams> {
  return {
    label: "Edit",
    name: "edit",
    description:
      "Replace exact text in a file. Each oldText must appear once unless `all` is set; copy it verbatim from a read. All edits are checked before the file is written.",
    parameters: EditParams,
    execute: async (_id, params: Static<typeof EditParams>): Promise<AgentToolResult<unknown>> => {
      const target = resolveToolPath(options.workspace, params.path, "edit path");
      const stat = fileStat(target);
      if (!stat) {
        throw new Error(`no such file: ${target}`);
      }
      if (stat.isDirectory()) {
        throw new Error(`${target} is a directory`);
      }
      const original = decodeUtf8Strict(readFileSync(target));
      const mode = existingMode(target);
      let next = original;
      const applied: string[] = [];
      for (const [index, edit] of params.edits.entries()) {
        const outcome = applyEdit(next, edit.oldText, edit.newText, edit.all === true, index);
        if (typeof outcome === "string") {
          throw new Error(outcome);
        }
        next = outcome.text;
        applied.push(`${outcome.count} replacement${outcome.count === 1 ? "" : "s"}`);
      }
      if (next === original) {
        return textResult("no change: replacement text was already identical", {
          path: target,
          changed: false,
        });
      }
      atomicWrite(target, next, mode);
      return textResult(
        `edited ${relativeTo(options.workspace.root, target)} (${applied.join(", ")})`,
        { path: target, changed: true, edits: params.edits.length },
      );
    },
  };
}

type EditOutcome = { text: string; count: number } | string;

function applyEdit(
  source: string,
  oldText: string,
  newText: string,
  all: boolean,
  index: number,
): EditOutcome {
  if (!oldText) {
    return `edit ${index + 1}: oldText is empty; give the exact text to replace`;
  }
  const matches: number[] = [];
  let cursor = source.indexOf(oldText);
  let more = false;
  while (cursor >= 0) {
    matches.push(cursor);
    if (!all && matches.length >= COUNT_CAP) {
      more = true;
      break;
    }
    cursor = source.indexOf(oldText, cursor + Math.max(1, oldText.length));
  }
  if (matches.length === 0) {
    return `edit ${index + 1}: oldText not found in the file. Re-read it and copy the exact text, including indentation.`;
  }
  if (!all && matches.length > 1) {
    // Counting every occurrence is cheap here (reads are capped at 2 MiB) and the
    // alternative is a message that lies: "matches 2 places" for a text that
    // occurs five times teaches the model to add just enough context to hit the
    // next ambiguous case.
    return `edit ${index + 1}: oldText matches ${matches.length}${more ? "+" : ""} places; include more surrounding lines to make it unique, or set all: true`;
  }
  let text = "";
  let last = 0;
  for (const at of matches) {
    text += source.slice(last, at) + newText;
    last = at + oldText.length;
  }
  text += source.slice(last);
  return { text, count: matches.length };
}

/** Octal mode of an existing file, or undefined when it does not exist yet. */
function existingMode(target: string): number | undefined {
  const stat = fileStat(target);
  return stat ? stat.mode & 0o777 : undefined;
}

/**
 * Writes through a sibling temp file and renames.
 *
 * `rename` is atomic within a filesystem, so a reader sees either the old file
 * or the new one, never a half-written one — which matters on a phone that can
 * lose power or fill `/data` mid-write.
 *
 * The temp file is created `0600` and the *previous* mode is restored after the
 * rename, never invented. Two failure modes this closes: editing a `0600` file
 * through a path that recreates it at `0644` (the umask default) and quietly
 * widening a credentials file, and an edit that dies halfway and leaves the
 * original truncated. New files stay `0600` deliberately: this is a private
 * workspace on a device, and a tool that creates world-readable files by default
 * is a tool that will eventually create a world-readable secret.
 */
function atomicWrite(target: string, content: string, previousMode: number | undefined): void {
  const temporary = `${target}.clawagent-tmp-${process.pid}`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temp file may not exist, or the rename may have consumed it. Either
      // way the original write failure is the one worth reporting.
    }
    throw error;
  }
  if (previousMode !== undefined) {
    try {
      chmodSync(target, previousMode);
    } catch {
      // Some Android mounts (FUSE, sdcardfs) reject chmod. The write succeeded;
      // failing it now would be worse than the mode we could not restore.
    }
  }
}

function relativeTo(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") ? relative : target;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  }
  return `${(kib / 1024).toFixed(1)} MiB`;
}

export { WorkspacePathError };
