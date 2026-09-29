// Single owner for Termux/Android host detection.
//
// Deliberately zero-dependency (node builtins only). This module runs before
// config, logging, and every workspace package load, for the same reason the
// repository's root `node-version.mjs` is a zero-dependency contract: a host
// detector that needs the runtime it is supposed to describe cannot report why
// that runtime failed.
//
// Shape mirrors `src/infra/wsl.ts`: an env-only fast path, a synchronous path, a
// process-cached result, and an explicit test reset.
//
// Why this module exists at all: Node built on Android reports
// `process.platform === "android"`, never `"linux"`. The desktop host has 112
// production `process.platform ===/!== "linux"` branches and zero Android host
// branches, so on a phone it silently takes the wrong path everywhere. Nothing
// outside `platform/` may re-derive these facts.

/**
 * Matches a Termux `$PREFIX` root. Requires the `files/usr` segment so a path
 * that merely mentions `com.termux` elsewhere (`/tmp/com.termux/usr`) cannot
 * produce a false positive.
 *
 * Keep byte-identical to `resolveTermuxHome()` in
 * `packages/normalization-core/src/home-dir.ts`. `termux.test.ts` asserts the two
 * agree, so the home-dir owner and the host owner cannot drift apart.
 */
const TERMUX_PREFIX_PATTERN = /(?:^|\/)com\.termux\/files\/usr\/?$/u;

/**
 * Trims an environment value and treats the literal strings a mis-serialized
 * config can produce as absent.
 *
 * A deliberate local copy of the normalization-core contract rather than an
 * import: this module must be loadable before any workspace package resolves,
 * which on Android means before a build step has produced `dist/`. The
 * agreement test in `termux.test.ts` is what keeps the copy honest.
 */
function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
}

let termuxHostCached: boolean | null = null;

/** Clears the cached detection result between isolated tests. */
export function resetTermuxHostStateForTests(): void {
  termuxHostCached = null;
}

/**
 * Reports whether Node itself was built for Android.
 *
 * This is the definitive signal, and the one the desktop host never checks:
 * `uname -s` still prints `Linux` and `$OSTYPE` prints `linux-android`, so
 * shell-based detection misclassifies Termux as desktop Linux and downloads
 * glibc binaries the Android kernel refuses to execute.
 */
export function isAndroidHostPlatform(
  platform: NodeJS.Platform | string = process.platform,
): boolean {
  return optionalValue(platform) === "android";
}

/** Normalizes a Termux `$PREFIX` value to a comparable absolute path, or undefined. */
export function resolveTermuxPrefix(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const prefix = optionalValue(env.PREFIX);
  if (!prefix) {
    return undefined;
  }
  const normalized = prefix.replace(/\\+/gu, "/").replace(/\/+$/u, "");
  return TERMUX_PREFIX_PATTERN.test(normalized) ? normalized : undefined;
}

/**
 * Detects Termux from environment variables alone, without touching the
 * filesystem or spawning anything.
 *
 * `ANDROID_DATA` is required alongside `$PREFIX` so a generic chroot that
 * happens to set `PREFIX` is not mistaken for Termux. This matches the
 * home-dir owner's contract.
 */
export function isTermuxEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(resolveTermuxPrefix(env)) && Boolean(optionalValue(env.ANDROID_DATA));
}

/**
 * Synchronously reports whether this process runs inside Termux on Android.
 *
 * True when Node reports the Android platform, or when the Termux environment
 * contract holds. The env path is not redundant: `proot-distro` guests and
 * rebuilt Node binaries can report `linux` while still living in a Termux
 * prefix, and a phone host needs Termux-specific remediation text either way.
 */
export function isTermuxHost(
  environment: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform | string } = {},
): boolean {
  const cacheProcessEnvironment =
    environment.env === undefined && environment.platform === undefined;
  if (cacheProcessEnvironment && termuxHostCached !== null) {
    return termuxHostCached;
  }
  const detected =
    isAndroidHostPlatform(environment.platform ?? process.platform) ||
    isTermuxEnv(environment.env ?? process.env);
  if (cacheProcessEnvironment) {
    termuxHostCached = detected;
  }
  return detected;
}

/**
 * Reports whether this process runs on Android outside Termux.
 *
 * Kept separate from `isTermuxHost` because the remediation differs: Termux has
 * `pkg` and `termux-api`, a bare Android Node build has neither.
 */
export function isAndroidWithoutTermux(
  environment: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform | string } = {},
): boolean {
  return (
    isAndroidHostPlatform(environment.platform ?? process.platform) &&
    !isTermuxEnv(environment.env ?? process.env)
  );
}

/** Everything a caller may need about the host, resolved once. */
export type TermuxHostInfo = {
  /** Running inside Termux on Android. */
  isTermux: boolean;
  /** Node reports the Android platform. */
  isAndroidPlatform: boolean;
  /** Termux `$PREFIX`, when the environment contract holds. */
  prefix?: string;
  /** Termux home derived from `$PREFIX`, when available. */
  home?: string;
  /** Which signal produced the verdict, for diagnostics. */
  signal: "android-platform" | "termux-env" | "none";
};

/** Resolves the complete host picture without spawning anything. */
export function readTermuxHostInfo(
  environment: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform | string } = {},
): TermuxHostInfo {
  const env = environment.env ?? process.env;
  const isAndroidPlatform = isAndroidHostPlatform(environment.platform ?? process.platform);
  const prefix = resolveTermuxPrefix(env);
  const envMatch = Boolean(prefix) && Boolean(optionalValue(env.ANDROID_DATA));
  return {
    isTermux: isAndroidPlatform || envMatch,
    isAndroidPlatform,
    ...(prefix ? { prefix, home: resolveTermuxHomeFromPrefix(prefix) } : {}),
    signal: isAndroidPlatform ? "android-platform" : envMatch ? "termux-env" : "none",
  };
}

/**
 * Derives the Termux home directory from `$PREFIX`.
 *
 * Termux has no `/etc/passwd` entry, and `os.homedir()` can disagree with the
 * real home when `HOME` is unset in a stripped environment (Termux:Boot, an
 * `sv` service, cron). `$PREFIX/..` is authoritative there.
 */
export function resolveTermuxHomeFromPrefix(prefix: string): string {
  const normalized = prefix.replace(/\\+/gu, "/").replace(/\/+$/u, "");
  const usrIndex = normalized.lastIndexOf("/usr");
  const filesRoot = usrIndex > 0 ? normalized.slice(0, usrIndex) : normalized;
  return `${filesRoot}/home`;
}
