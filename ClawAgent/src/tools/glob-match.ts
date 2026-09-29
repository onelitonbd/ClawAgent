// Glob matching, owned here rather than delegated.
//
// `fs.globSync` exists on the Node lines this host targets, but it is younger
// than the rest of the `fs` API this file relies on and its dotfile and
// directory-skipping behaviour is not the behaviour a tool description promises.
// Owning ~40 lines means the tests here describe exactly what runs on a phone.
//
// Supported syntax, which is the set models reach for and nothing more:
//   *        within one path segment
//   **       across segments, and `**/` may also match nothing
//   ?        one character within a segment
//   [abc]    class; [!abc] and [^abc] negate
//   {a,b}    alternation
// A pattern with no `/` is treated as a basename match at any depth, because
// `*.ts` meaning "only the top directory" surprises everyone.

/** Characters that carry meaning in a glob and must not be escaped blindly. */
const GLOB_SPECIAL = new Set(["*", "?", "[", "]", "{", "}", "!"]);

/**
 * Compiles a glob into a regular expression anchored to a whole relative path.
 *
 * Unbalanced `[` or `{` is a user error, not something to paper over: an
 * silently-loosened pattern turns "find my config" into "find every file".
 */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern.trim();
  if (!source) {
    throw new TypeError("glob pattern is empty");
  }
  let out = "";
  let index = 0;
  let inClass = false;
  // A wildcard at the start of a segment must not match a leading dot, which is
  // the one glob convention every shell, minimatch, and gitignore agrees on and
  // the reason `*.env` does not quietly expose `.env`.
  let atSegmentStart = true;
  const guard = (body: string): string => (atSegmentStart ? `(?!\\.)${body}` : body);
  while (index < source.length) {
    const char = source[index] as string;
    if (inClass) {
      if (char === "]") {
        inClass = false;
        out += "]";
        index += 1;
        continue;
      }
      if (char === "\\") {
        out += "\\\\";
        index += 2;
        continue;
      }
      out += char;
      index += 1;
      continue;
    }
    if (char === "[") {
      const negated = source[index + 1] === "!" || source[index + 1] === "^";
      const open = index;
      let close = index + (negated ? 2 : 1);
      while (close < source.length && source[close] !== "]") {
        close += 1;
      }
      if (close >= source.length) {
        throw new TypeError(`unbalanced [ in glob pattern: ${pattern}`);
      }
      const body = source.slice(open + 1 + (negated ? 1 : 0), close);
      out += guard(`[${negated ? "^/" : ""}${body.replace(/\\/gu, "\\\\")}]`);
      index = close + 1;
      continue;
    }
    if (char === "{") {
      const close = findClosing(source, index, "{", "}");
      if (close < 0) {
        throw new TypeError(`unbalanced { in glob pattern: ${pattern}`);
      }
      const alternatives = splitTopLevel(source.slice(index + 1, close), ",");
      out += `(?:${alternatives.map((part) => compileSegment(part, pattern)).join("|")})`;
      index = close + 1;
      continue;
    }
    if (char === "*") {
      const doubled = source[index + 1] === "*";
      if (doubled) {
        const afterStar = source[index + 2];
        if (afterStar === "/") {
          // `a/**/b` also matches `a/b`; `**/b` also matches `b`.
          out += "(?:.*/)?";
          index += 3;
          continue;
        }
        // `a**b` is not POSIX glob, but treating a bare `**` as "anything"
        // matches what every other tool in this space does with it.
        out += ".*";
        index += 2;
        continue;
      }
      out += guard("[^/]*");
      index += 1;
      continue;
    }
    if (char === "?") {
      out += guard("[^/]");
      index += 1;
      continue;
    }
    if (GLOB_SPECIAL.has(char)) {
      // `!` outside a class and any leftover brace-ish special is literal.
      out += escapeRegExpChar(char);
      index += 1;
      continue;
    }
    out += escapeRegExpChar(char);
    atSegmentStart = char === "/";
    index += 1;
  }
  return new RegExp(`^${out}$`, "u");
}

function compileSegment(part: string, pattern: string): string {
  try {
    // Recurse so `{*.ts,*.js}` and nested classes behave, then strip anchors.
    return globToRegExp(part).source.replace(/^\^/u, "").replace(/$/u, "");
  } catch (error) {
    throw new TypeError(
      `bad alternative "${part}" in glob pattern: ${pattern}${error instanceof Error ? ` (${error.message})` : ""}`,
      { cause: error },
    );
  }
}

function findClosing(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === open) {
      depth += 1;
    } else if (source[index] === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of source) {
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
}

/**
 * True when `relativePath` matches `pattern`.
 *
 * A slash-free pattern also matches at any depth (`*.ts` finds `src/a.ts`), but
 * never against a dotfile segment, because `*` should not surface `.env` and
 * friends by accident. `**` still reaches them when asked explicitly.
 */
export function matchesGlob(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const expression = globToRegExp(pattern.trim());
  if (expression.test(normalized)) {
    return true;
  }
  if (!pattern.includes("/")) {
    return !hasHiddenSegment(normalized) && globToRegExp(`**/${pattern.trim()}`).test(normalized);
  }
  return false;
}

function hasHiddenSegment(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}
