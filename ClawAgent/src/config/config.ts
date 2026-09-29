// Reading `clawagent.json`.
//
// The config surface is deliberately small: a phone is not where anyone wants to
// maintain a 400-line YAML file. Everything here has an environment-variable
// override, because on Termux editing a JSON file means opening `$EDITOR` in a
// terminal keyboard, while `CLAWAGENT_MODEL=... clawagent chat` is one line.
//
// Precedence: environment > config file > built-in defaults.
//
// Problems are collected and returned rather than thrown. A config with one bad
// number should still start with the rest of it intact, and the message should
// say which key was wrong.

import fs from "node:fs";
import type { ModelConfig } from "../provider/model.ts";
import type { ClawAgentPaths } from "./paths.ts";

/** Per-conversation settings. */
export type ChatSettings = {
  systemPrompt?: string;
  temperature?: number;
  /** Per-turn output cap; overrides the model descriptor when set. */
  maxTokens?: number;
};

/** How much the tool layer may do on its own. See `src/approvals/policy.ts`. */
export type AgentSettings = {
  /**
   * Approval mode name, kept as a string here on purpose: the set of valid
   * modes belongs to the approval policy, and this module does not import it.
   * A bad value is reported by the `agent` command, which can name the legal
   * ones, rather than being dropped silently at parse time.
   */
  approve?: string;
  /** Workspace root the agent is confined to. */
  workspace?: string;
  systemPrompt?: string;
  maxTurns?: number;
};

export type ClawAgentConfig = {
  model?: ModelConfig;
  chat?: ChatSettings;
  agent?: AgentSettings;
};

/** Config file name, exported so `doctor` can name the file it looked for. */
export const KNOWN_CONFIG_KEYS: readonly string[] = ["model", "chat", "agent"];

const KNOWN_MODEL_KEYS: readonly string[] = [
  "provider",
  "id",
  "name",
  "baseUrl",
  "api",
  "maxTokens",
  "contextWindow",
  "reasoning",
  "input",
  "headers",
  "authHeader",
];

const KNOWN_CHAT_KEYS: readonly string[] = ["systemPrompt", "temperature", "maxTokens"];
const KNOWN_AGENT_KEYS: readonly string[] = ["approve", "workspace", "systemPrompt", "maxTurns"];

export type ParsedConfig = {
  config: ClawAgentConfig;
  /** Human-readable problems; empty means the file was usable as-is. */
  problems: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Rejects keys the config schema does not define.
 *
 * This is the whole point of strictness here: `baseurl` instead of `baseUrl`
 * silently produces "no baseUrl could be determined" two layers later, and on a
 * phone that reads like a broken install rather than a typo.
 */
function unknownKeys(
  record: Record<string, unknown>,
  known: readonly string[],
  prefix: string,
): string[] {
  return Object.keys(record)
    .filter((key) => !known.includes(key))
    .map((key) => `${prefix}${key} is not a known setting`);
}

function parseModelSection(value: unknown, problems: string[]): ModelConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    problems.push("model must be an object");
    return undefined;
  }
  problems.push(...unknownKeys(value, KNOWN_MODEL_KEYS, "model."));

  const model: ModelConfig = {};
  for (const key of ["provider", "id", "name", "baseUrl", "api"] as const) {
    const text = nonEmptyString(value[key]);
    if (text) {
      model[key] = text;
    } else if (value[key] !== undefined && value[key] !== null) {
      problems.push(`model.${key} must be a non-empty string`);
    }
  }
  for (const key of ["maxTokens", "contextWindow"] as const) {
    const raw = value[key];
    if (raw === undefined || raw === null) {
      continue;
    }
    const number = positiveNumber(raw);
    if (number) {
      model[key] = Math.floor(number);
    } else {
      problems.push(`model.${key} must be a positive number`);
    }
  }
  if (value.reasoning !== undefined && value.reasoning !== null) {
    if (typeof value.reasoning === "boolean") {
      model.reasoning = value.reasoning;
    } else {
      problems.push("model.reasoning must be true or false");
    }
  }
  if (value.input !== undefined && value.input !== null) {
    const input = value.input;
    if (
      Array.isArray(input) &&
      input.length > 0 &&
      input.every((entry) => entry === "text" || entry === "image")
    ) {
      model.input = input as ("text" | "image")[];
    } else {
      problems.push('model.input must be a non-empty array of "text" or "image"');
    }
  }
  if (value.headers !== undefined && value.headers !== null) {
    const headers = value.headers;
    if (isRecord(headers) && Object.values(headers).every((entry) => typeof entry === "string")) {
      model.headers = Object.fromEntries(
        Object.entries(headers).map(([key, entry]) => [key, String(entry)]),
      );
    } else {
      problems.push("model.headers must be an object of string values");
    }
  }
  if (value.authHeader !== undefined && value.authHeader !== null) {
    if (typeof value.authHeader === "boolean") {
      model.authHeader = value.authHeader;
    } else {
      problems.push("model.authHeader must be true or false");
    }
  }
  return model;
}

function parseChatSection(value: unknown, problems: string[]): ChatSettings | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    problems.push("chat must be an object");
    return undefined;
  }
  problems.push(...unknownKeys(value, KNOWN_CHAT_KEYS, "chat."));

  const chat: ChatSettings = {};
  const systemPrompt = nonEmptyString(value.systemPrompt);
  if (systemPrompt) {
    chat.systemPrompt = systemPrompt;
  }
  for (const key of ["temperature", "maxTokens"] as const) {
    const raw = value[key];
    if (raw === undefined || raw === null) {
      continue;
    }
    const number = positiveNumber(raw);
    if (number) {
      chat[key] = number;
    } else {
      problems.push(`chat.${key} must be a positive number`);
    }
  }
  // Temperature is meaningful only up to the provider's ceiling; 0 is legitimate
  // but `positiveNumber` rejects it, so it is handled explicitly.
  if (value.temperature === 0) {
    chat.temperature = 0;
  }
  return chat;
}

function parseAgentSection(value: unknown, problems: string[]): AgentSettings | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    problems.push("agent must be an object");
    return undefined;
  }
  problems.push(...unknownKeys(value, KNOWN_AGENT_KEYS, "agent."));

  const agent: AgentSettings = {};
  for (const key of ["approve", "workspace", "systemPrompt"] as const) {
    const text = nonEmptyString(value[key]);
    if (text) {
      agent[key] = text;
    }
  }
  if (value.maxTurns !== undefined && value.maxTurns !== null) {
    const turns = positiveNumber(value.maxTurns);
    if (turns) {
      // A fractional `maxTurns` would round into a limit nobody wrote down.
      agent.maxTurns = Math.floor(turns);
    } else {
      problems.push("agent.maxTurns must be a positive number");
    }
  }
  return agent;
}

/** Parses config JSON text. Malformed JSON is one problem, not a throw. */
export function parseConfigJson(raw: string): ParsedConfig {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      config: {},
      problems: [`config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!isRecord(parsed)) {
    return { config: {}, problems: ["config must be a JSON object"] };
  }
  problems.push(...unknownKeys(parsed, KNOWN_CONFIG_KEYS, ""));

  const model = parseModelSection(parsed.model, problems);
  const chat = parseChatSection(parsed.chat, problems);
  const agent = parseAgentSection(parsed.agent, problems);
  return {
    config: {
      ...(model ? { model } : {}),
      ...(chat ? { chat } : {}),
      ...(agent ? { agent } : {}),
    },
    problems,
  };
}

export type LoadedConfig = ParsedConfig & {
  /** The file that was read, or undefined when none exists. */
  file: string | undefined;
};

/** Reads the config file. A missing file is normal and reports no problems. */
export function loadConfigFile(file: string): LoadedConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { config: {}, problems: [], file: undefined };
    }
    return {
      config: {},
      problems: [`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`],
      file,
    };
  }
  const parsed = parseConfigJson(raw);
  return { ...parsed, file };
}

/** Config file path for a resolved state layout. */
export function configFileFor(paths: ClawAgentPaths): string {
  return paths.configFile;
}

/** Environment overrides, so a one-off model needs no file edit. */
export const ENV_OVERRIDES = {
  provider: "CLAWAGENT_PROVIDER",
  model: "CLAWAGENT_MODEL",
  baseUrl: "CLAWAGENT_BASE_URL",
  api: "CLAWAGENT_API",
  apiKey: "CLAWAGENT_API_KEY",
  maxTokens: "CLAWAGENT_MAX_TOKENS",
  systemPrompt: "CLAWAGENT_SYSTEM_PROMPT",
  temperature: "CLAWAGENT_TEMPERATURE",
  approve: "CLAWAGENT_APPROVE",
  workspace: "CLAWAGENT_WORKSPACE",
} as const;

/**
 * Layers environment overrides on top of file config.
 *
 * Only variables that are actually set take part; an empty `CLAWAGENT_MODEL=`
 * is ignored rather than clearing the configured model, because an empty export
 * left in a shell profile is a common accident.
 */
export function applyEnvOverrides(
  config: ClawAgentConfig,
  env: Record<string, string | undefined>,
  problems: string[] = [],
): ClawAgentConfig {
  const model: ModelConfig = { ...(config.model ?? {}) };
  const chat: ChatSettings = { ...(config.chat ?? {}) };
  const agent: AgentSettings = { ...(config.agent ?? {}) };

  const provider = nonEmptyString(env[ENV_OVERRIDES.provider]);
  if (provider) {
    model.provider = provider;
  }
  const modelId = nonEmptyString(env[ENV_OVERRIDES.model]);
  if (modelId) {
    model.id = modelId;
  }
  const baseUrl = nonEmptyString(env[ENV_OVERRIDES.baseUrl]);
  if (baseUrl) {
    model.baseUrl = baseUrl;
  }
  const api = nonEmptyString(env[ENV_OVERRIDES.api]);
  if (api) {
    model.api = api;
  }
  const maxTokens = nonEmptyString(env[ENV_OVERRIDES.maxTokens]);
  if (maxTokens) {
    const number = Number(maxTokens);
    if (Number.isFinite(number) && number > 0) {
      model.maxTokens = Math.floor(number);
    } else {
      problems.push(`${ENV_OVERRIDES.maxTokens} must be a positive number`);
    }
  }
  const systemPrompt = nonEmptyString(env[ENV_OVERRIDES.systemPrompt]);
  if (systemPrompt) {
    chat.systemPrompt = systemPrompt;
  }
  const temperature = nonEmptyString(env[ENV_OVERRIDES.temperature]);
  if (temperature) {
    const number = Number(temperature);
    if (Number.isFinite(number) && number >= 0) {
      chat.temperature = number;
    } else {
      problems.push(`${ENV_OVERRIDES.temperature} must be a number >= 0`);
    }
  }

  // The two agent variables are stored verbatim: whether `full` is a legal mode
  // is the approval policy's answer to give, and it gives one with the list of
  // real modes in the error. Re-checking the set here would put the same rule in
  // two files, where one of them will eventually be wrong.
  const approve = nonEmptyString(env[ENV_OVERRIDES.approve]);
  if (approve) {
    agent.approve = approve;
  }
  const workspace = nonEmptyString(env[ENV_OVERRIDES.workspace]);
  if (workspace) {
    agent.workspace = workspace;
  }

  return {
    ...(Object.keys(model).length > 0 ? { model } : {}),
    ...(Object.keys(chat).length > 0 ? { chat } : {}),
    ...(Object.keys(agent).length > 0 ? { agent } : {}),
  };
}

export type ResolvedConfig = {
  config: ClawAgentConfig;
  file: string | undefined;
  problems: string[];
};

/** Reads the config file and applies environment overrides. */
export function resolveConfig(
  paths: ClawAgentPaths | undefined,
  env: Record<string, string | undefined>,
): ResolvedConfig {
  const problems: string[] = [];
  const loaded = paths ? loadConfigFile(paths.configFile) : { config: {}, problems: [], file: undefined };
  problems.push(...loaded.problems);
  const config = applyEnvOverrides(loaded.config, env, problems);
  return {
    config,
    ...(loaded.file ? { file: loaded.file } : { file: undefined }),
    problems,
  };
}
