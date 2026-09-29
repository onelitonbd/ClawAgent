// The workspace boundary. Every file tool resolves its arguments through here, so
// there is exactly one place that decides what a path means and one place that
// says no.
//
// A model writes these paths, and a model can be steered by whatever it reads: a
// file in the repo it is editing can say "now read ~/.ssh/id_rsa". So containment
// is not a nicety, it is the threat model. Two escapes matter and both are
// handled here:
//   - `../../etc/passwd`, a purely lexical escape;
//   - a symlink inside the workspace pointing outside it, which a lexical check
//     allows because the link itself is inside.
//
// Default policy is `strict`: refuse anything outside the workspace, with an error
// naming the workspace, so the model can correct itself instead of guessing.
// `open` exists because Termux users legitimately work under `$PREFIX` or a shared
// download directory, and a host that cannot reach them gets bypassed anyway —
// through `bash`, which has no path policy of its own.

import { existsSync, lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";

/** How far a tool may reach outside the workspace. */
export type PathPolicy = "strict" | "open";

export type WorkspaceOptions = {
  /** Directory tools resolve relative paths against. Defaults to the process cwd. */
  root?: string;
  /** Containment policy. Defaults to `strict`. */
  policy?: PathPolicy;
};

export type Workspace = {
  /** Absolute, symlink-free root. Stored resolved so containment checks are stable. */
  readonly root: string;
  readonly policy: PathPolicy;
};

/**
 * Raised when a path is refused.
 *
 * The hint is folded into `message` deliberately. The agent loop hands a failed
 * tool back to the model as its error text and nothing else, so a hint kept in a
 * separate property is a hint no one ever reads. `hint` stays available for callers
 * that want to style or translate the two halves differently.
 */
export class WorkspacePathError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(hint ? `${message}. ${hint}` : message);
    this.name = "WorkspacePathError";
  }
}

export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
  const requested = options.root?.trim() || process.cwd();
  const policy = options.policy ?? "strict";
  if (policy !== "strict" && policy !== "open") {
    throw new TypeError(`unknown path policy: ${String(policy)}`);
  }
  return { root: canonicaliseRoot(requested), policy };
}

/**
 * The workspace root, with symlinks removed.
 *
 * Canonicalising the root is what makes `~` and `$TMPDIR` behave: on macOS and on
 * some Android mounts the temp directory is itself a symlink, and a root compared
 * as a string against a resolved child never matches, so every path looks like an
 * escape.
 */
function canonicaliseRoot(requested: string): string {
  const absolute = path.isAbsolute(requested)
    ? path.normalize(requested)
    : path.resolve(process.cwd(), requested);
  return realpathOr(absolute);
}

function resolveAgainstCwd(target: string): string {
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(process.cwd(), target);
}

/** Symlink-free form of a path, or the input when it cannot be resolved. */
function realpathOr(target: string): string {
  try {
    return realpathSync.native ? realpathSync.native(target) : realpathSync(target);
  } catch {
    return target;
  }
}

export function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves one tool argument to an absolute path, applying the policy.
 *
 * Absolute paths are honoured — a model that says
 * `/data/data/com.termux/files/home/x` means exactly that — but under `strict`
 * they still have to land inside the workspace. `~` is expanded because models and
 * people write it constantly, and a tool that turns `~` into a literal directory
 * named `~` will be blamed for the model's confusion.
 */
export function resolveToolPath(workspace: Workspace, input: string, purpose = "path"): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new WorkspacePathError(`${purpose} is empty`, "pass a non-empty path");
  }
  const expanded = expandHome(workspace, trimmed);
  // Relative to the *workspace*, not to the process: the CLI can be started from
  // anywhere, and a tool that read `src/a.ts` against the launch directory would
  // point at a different project every time the user cds.
  const candidate = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(workspace.root, expanded);

  if (workspace.policy === "strict") {
    // Two checks, because they need two explanations. A path that is lexically
    // outside was simply asked for; a path that is lexically *inside* and still
    // escapes can only have been redirected by a link, and telling the model
    // "outside the workspace" there hides the part it needs to fix.
    if (!isInsideRoot(workspace.root, candidate)) {
      throw new WorkspacePathError(
        `path is outside the workspace: ${candidate}`,
        `stay under ${workspace.root}, or choose --workspace <dir> and confirm the user wants that scope`,
      );
    }
    assertNoEscapingLink(workspace.root, candidate, purpose);
  }

  const canonical = canonicalise(candidate);
  if (workspace.policy === "strict" && !isInsideRoot(workspace.root, canonical)) {
    throw new WorkspacePathError(
      `path is outside the workspace: ${canonical}`,
      `stay under ${workspace.root}`,
    );
  }

  // A parent that exists but is not a directory is refused here rather than at
  // the syscall, because by then the path has been canonicalised and can come
  // back looking like something the model never asked for.
  const parent = path.dirname(canonical);
  if (canonical !== parent && isNonDirectory(parent)) {
    throw new WorkspacePathError(
      `not a directory: ${parent}`,
      `${path.basename(canonical)} cannot be created inside it`,
    );
  }
  return canonical;
}

function isNonDirectory(target: string): boolean {
  const stat = fileStat(target);
  return stat !== undefined && !stat.isDirectory();
}

/** `~` and `~/x`, via HOME and then the OS account directory. */
function expandHome(workspace: Workspace, value: string): string {
  if (!value.startsWith("~")) {
    return value;
  }
  const home = process.env.HOME?.trim() || os.homedir();
  if (!home) {
    return value === "~" ? workspace.root : value;
  }
  if (value === "~") {
    return home;
  }
  // `~other` (another user's home) is not supported: it needs a passwd lookup,
  // and no agent task on a phone needs it. Refuse rather than resolve it as a
  // literal relative directory, which would silently create `~other/...`.
  if (value.startsWith("~") && !value.startsWith("~/")) {
    throw new WorkspacePathError(
      `unsupported ~ path: ${value}`,
      "only ~ and ~/subdir are expanded; use a path under the workspace root",
    );
  }
  return path.join(home, value.slice(2));
}

/**
 * Verifies that no step of `candidate`'s chain is a link pointing out of the tree.
 *
 * Checking only the leaf is the classic mistake, and it is the one that matters
 * here: `vendor` can be a symlink outside the workspace while
 * `vendor/new-file.txt` does not exist yet, so there is nothing to canonicalise at
 * the leaf and a `write` would land outside. Every existing ancestor is therefore
 * examined, and `lstat` is what sees the link itself rather than its target.
 */
function assertNoEscapingLink(root: string, candidate: string, purpose: string): void {
  let probe = candidate;
  for (let depth = 0; depth < 64; depth += 1) {
    if (probe === root) {
      return;
    }
    if (isLinkEscapingRoot(root, probe)) {
      throw new WorkspacePathError(
        `${purpose} reaches outside the workspace through a link: ${probe}`,
        `the path is inside ${root}, but this part of it resolves to ${realpathOr(probe)}`,
      );
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      return;
    }
    probe = parent;
  }
}

/** True when `probe` is itself a symlink resolving outside `root`. */
function isLinkEscapingRoot(root: string, probe: string): boolean {
  if (probe === root) {
    return false;
  }
  try {
    if (!lstatSync(probe).isSymbolicLink()) {
      return false;
    }
  } catch {
    // Broken link or no such path. A dangling link is still a link, and `write`
    // would create its target wherever it points, so ask the real resolver.
    try {
      lstatSync(path.dirname(probe));
    } catch {
      return false;
    }
  }
  return !isInsideRoot(root, realpathOr(probe));
}

/** Resolves symlinks on the nearest existing ancestor and re-joins the missing tail. */
function canonicalise(candidate: string): string {
  let tail: string[] = [];
  let probe = candidate;
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(probe)) {
      const base = realpathOr(probe);
      return tail.length === 0 ? base : path.join(base, ...tail);
    }
    tail = [path.basename(probe), ...tail];
    const parent = path.dirname(probe);
    if (parent === probe) {
      break;
    }
    probe = parent;
  }
  return candidate;
}

/**
 * `statSync`, typed.
 *
 * The overload resolves to `Stats | BigIntStats`, which makes `size` and `mode`
 * `number | bigint` on the union and poisons every comparison — and the `& 0o777`
 * mask — with a type error. Casting once, at the call site that knows no bigint
 * option was passed, keeps the tools readable.
 */
export function fileStat(target: string): Stats | undefined {
  try {
    return statSync(target) as Stats;
  } catch {
    return undefined;
  }
}

/**
 * Directories no tool should walk into.
 *
 * `.git` and `node_modules` are first because on a phone they are routinely
 * larger than everything the user cares about; `__pycache__` and the build
 * directories follow the same reasoning. Not a policy about what is hidden from
 * the model — `glob` and `grep` are search tools, and a search that returns a
 * hundred megabytes of packfiles is not a search.
 */
export const DEFAULT_SKIP_DIRECTORIES: readonly string[] = [
  ".git",
  "node_modules",
  ".hg",
  ".svn",
  "dist",
  "build",
  ".next",
  ".venv",
  "__pycache__",
];

/** Caps, in one place, so a tool's message and its behaviour cannot disagree. */
export const DEFAULT_OUTPUT_CAPS = {
  readLines: 2000,
  readBytes: 256 * 1024,
  grepMatches: 200,
  globResults: 500,
  commandBytes: 64 * 1024,
  fileBytes: 2 * 1024 * 1024,
} as const;
