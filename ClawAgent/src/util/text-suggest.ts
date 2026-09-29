// Nearest-name suggestion and secret masking for user-facing output.
//
// Lives below both `cli/` and `provider/` on purpose: command names, provider
// ids, and model ids all get mistyped on a phone keyboard, and a typo should
// answer with the nearest valid value rather than a stack trace. Keeping it here
// stops `provider/` from depending on `cli/`, which is the wrong way round.

/** Levenshtein distance, with an early exit once `limit` is exceeded. */
export function editDistance(a: string, b: string, limit = 8): number {
  if (a === b) {
    return 0;
  }
  if (Math.abs(a.length - b.length) > limit) {
    return limit + 1;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // `noUncheckedIndexedAccess` cannot see that i-1, j-1 and j are in range
      // by construction. Falling back to +Infinity rather than 0 keeps a genuine
      // bounds mistake visible as an obviously wrong distance instead of
      // silently producing a plausible one.
      const deletion = (current[j - 1] ?? Number.POSITIVE_INFINITY) + 1;
      const insertion = (previous[j] ?? Number.POSITIVE_INFINITY) + 1;
      const substitution = (previous[j - 1] ?? Number.POSITIVE_INFINITY) + cost;
      current[j] = Math.min(deletion, insertion, substitution);
    }
    if (Math.min(...current) > limit) {
      return limit + 1;
    }
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/**
 * Suggests the closest known name for a typo.
 *
 * Prefix matching first (covers `doc` -> `doctor`), then a bounded edit
 * distance. Deliberately conservative: a confident wrong suggestion is worse
 * than none, because the user acts on it.
 */
export function suggestName(input: string, names: readonly string[]): string | undefined {
  const lower = input.toLowerCase();
  const exact = names.find((name) => name === lower);
  if (exact) {
    return exact;
  }
  const prefix = names.find((name) => name.startsWith(lower) && lower.length >= 2);
  if (prefix) {
    return prefix;
  }
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const distance = editDistance(lower, name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  // Only suggest when the typo is genuinely close.
  return bestDistance <= 2 ? best : undefined;
}

/**
 * Masks a secret for display, keeping only the tail.
 *
 * Enough to tell two keys apart in a report, never enough to reconstruct one.
 * Short values are masked entirely: the last four characters of a six-character
 * value is most of the secret.
 */
export function maskSecret(value: string, keep = 4): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= keep * 2) {
    return "*".repeat(trimmed.length);
  }
  return `${"*".repeat(keep)}${trimmed.slice(-keep)}`;
}
