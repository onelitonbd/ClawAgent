// API key resolution.
//
// The provider adapters in `@openclaw/ai` read `process.env` themselves as a last
// resort, so a missing key would otherwise surface as a bare 401 from the vendor
// SDK. On a phone that is indistinguishable from a broken install, so resolution
// happens here first: the failure names the exact variables to set.
//
// Precedence, most explicit first:
//   1. `CLAWAGENT_API_KEY` — a deliberate per-invocation override
//   2. `credentials/api-keys.json` — persisted on this device
//   3. provider-conventional variables (`ANTHROPIC_API_KEY`, ...)
//
// A resolved key is never logged or printed in full. `maskSecret` keeps enough to
// tell two keys apart in `doctor` output and nothing more.
//
// `@openclaw/ai` has its own env-key conventions in `src/env-api-keys.ts`, but
// that module is not part of the package's public `exports` map, so importing it
// would depend on an internal file path. The conventional names live in
// `provider/presets.ts` instead, which is also where a custom endpoint's name
// would be added.

import fs from "node:fs";
import path from "node:path";
import { ENV_OVERRIDES } from "../config/config.ts";
import { maskSecret } from "../util/text-suggest.ts";

/** Where a persisted key came from. */
export type ApiKeySource = "override-env" | "credentials-file" | "provider-env" | "none";

export type ApiKeyResolution = {
  key: string | undefined;
  source: ApiKeySource;
  /** The variable or file the key was found in, for diagnostics. */
  foundIn?: string;
  problems: string[];
};

/** File name inside the credentials directory. */
export const API_KEYS_FILE_NAME = "api-keys.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readKeyFromValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (isRecord(value)) {
    const nested = value.apiKey ?? value.api_key ?? value.key;
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }
  return undefined;
}

/**
 * Flags a credentials file that other local users or apps could read.
 *
 * Termux home directories are normally private, but a state root pointed at
 * shared storage is not, and a world-readable key file is a real leak rather
 * than a style complaint.
 */
function credentialsFileModeProblem(file: string, mode: number): string | undefined {
  // 0o077 covers group and other read/write/execute.
  if (mode & 0o077) {
    return `${file} is readable by others (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${file}`;
  }
  return undefined;
}

export type CredentialsFileResult = {
  key: string | undefined;
  file: string;
  problems: string[];
};

/** Reads one provider's key from `credentials/api-keys.json`. */
export function readCredentialsFile(
  credentialsDir: string | undefined,
  provider: string,
): CredentialsFileResult | undefined {
  if (!credentialsDir) {
    return undefined;
  }
  const file = path.join(credentialsDir, API_KEYS_FILE_NAME);
  let raw: string;
  let stats: fs.Stats;
  try {
    stats = fs.statSync(file);
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing credentials file is the normal case, not a problem.
    if (code === "ENOENT") {
      return undefined;
    }
    return {
      key: undefined,
      file,
      problems: [`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const problems: string[] = [];
  const modeProblem = credentialsFileModeProblem(file, stats.mode);
  if (modeProblem) {
    problems.push(modeProblem);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    problems.push(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { key: undefined, file, problems };
  }
  if (!isRecord(parsed)) {
    problems.push(`${file} must be a JSON object keyed by provider id`);
    return { key: undefined, file, problems };
  }

  const key = readKeyFromValue(parsed[provider]);
  return { ...(key ? { key } : { key: undefined }), file, problems };
}

export type ApiKeyLookup = {
  /** Provider id, used for the credentials file and error text. */
  provider: string;
  /** Conventional variable names for this provider, in priority order. */
  envVars?: readonly string[];
  env: Record<string, string | undefined>;
  credentialsDir?: string;
  /** Model id, only for error text. */
  modelId?: string;
};

/** Resolves an API key, or explains precisely why it could not. */
export function resolveApiKey(lookup: ApiKeyLookup): ApiKeyResolution {
  const problems: string[] = [];

  const override = lookup.env[ENV_OVERRIDES.apiKey]?.trim();
  if (override) {
    return {
      key: override,
      source: "override-env",
      foundIn: ENV_OVERRIDES.apiKey,
      problems,
    };
  }

  const fromFile = readCredentialsFile(lookup.credentialsDir, lookup.provider);
  if (fromFile) {
    problems.push(...fromFile.problems);
    if (fromFile.key) {
      return {
        key: fromFile.key,
        source: "credentials-file",
        foundIn: fromFile.file,
        problems,
      };
    }
  }

  const envVars = lookup.envVars ?? [];
  for (const envVar of envVars) {
    const value = lookup.env[envVar]?.trim();
    if (value) {
      return { key: value, source: "provider-env", foundIn: envVar, problems };
    }
  }

  const target = lookup.modelId ? `${lookup.provider}/${lookup.modelId}` : lookup.provider;
  const setters = [
    ...envVars.map((envVar) => `export ${envVar}=...`),
    `export ${ENV_OVERRIDES.apiKey}=...`,
    `or put {"${lookup.provider}": "..."} in ${API_KEYS_FILE_NAME}`,
  ];
  problems.push(
    `no API key found for ${target}. ${setters.length > 0 ? `Try: ${setters.join("; ")}` : ""}`,
  );
  return { key: undefined, source: "none", problems };
}

/** One-line, safe-to-print summary of where a key came from. */
export function describeApiKey(resolution: ApiKeyResolution): string {
  if (!resolution.key) {
    return "not configured";
  }
  const where = resolution.foundIn ? ` (${resolution.foundIn})` : "";
  return `${maskSecret(resolution.key)}${where}`;
}
