// Building a `Model` descriptor for the shared LLM runtime.
//
// `@openclaw/ai` routes on `model.api` and `model.provider`, so a descriptor has
// to be assembled before anything can be streamed. This module turns a small
// config object into one, filling in routing facts from `./presets.ts`.
//
// It returns a result rather than throwing: a mistyped provider id in a config
// file on a phone should produce "unknown provider 'antropic', did you mean
// 'anthropic'?" and not a stack trace.

import type { Model } from "@openclaw/llm-core";
import { findProviderPreset, providerPresetIds, type ProviderPreset } from "./presets.ts";
import { suggestName } from "../util/text-suggest.ts";

/** Default output token budget when config does not say. */
export const DEFAULT_MAX_TOKENS = 4096;

/** Model settings a user is expected to edit. */
export type ModelConfig = {
  /** Preset id, e.g. `anthropic`, or any string when `api`/`baseUrl` are given. */
  provider?: string;
  /** Provider-side model id, e.g. `claude-sonnet-4-5`. */
  id?: string;
  /** Display name; defaults to `id`. */
  name?: string;
  /** Overrides the preset base URL (proxies, gateways, local servers). */
  baseUrl?: string;
  /** Overrides the preset protocol adapter. */
  api?: string;
  maxTokens?: number;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  headers?: Record<string, string>;
  authHeader?: boolean;
};

/** A resolved descriptor plus the routing facts the caller needs next. */
export type ResolvedModel = {
  model: Model;
  preset: ProviderPreset | undefined;
  /** Environment variable names to check for a key, in priority order. */
  apiKeyEnvVars: string[];
};

export type ResolveModelResult =
  | { ok: true; value: ResolvedModel }
  | { ok: false; error: string; hint?: string };

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Resolves a model descriptor from config.
 *
 * A provider preset is required unless the config supplies both `api` and
 * `baseUrl`, which is how an arbitrary OpenAI-compatible endpoint is used
 * without adding a preset for it.
 */
export function resolveModel(config: ModelConfig = {}): ResolveModelResult {
  const providerId = config.provider?.trim();
  const modelId = config.id?.trim();
  if (!modelId) {
    return {
      ok: false,
      error: "no model id configured",
      hint: `set model.id in clawagent.json, for example {"model":{"provider":"anthropic","id":"claude-sonnet-4-5"}}`,
    };
  }

  const preset = providerId ? findProviderPreset(providerId) : undefined;
  if (providerId && !preset) {
    const known = providerPresetIds();
    const suggestion = suggestName(providerId, known);
    return {
      ok: false,
      error: `unknown provider: ${providerId}`,
      hint: suggestion
        ? `did you mean "${suggestion}"? known providers: ${known.join(", ")}`
        : `known providers: ${known.join(", ")}`,
    };
  }

  const api = config.api?.trim() || preset?.api;
  const baseUrl = config.baseUrl?.trim() || preset?.baseUrl || "";
  if (!api) {
    return {
      ok: false,
      error: "no protocol adapter (api) could be determined",
      hint: "set model.provider to a known preset, or set model.api explicitly",
    };
  }
  if (!baseUrl) {
    return {
      ok: false,
      error: "no baseUrl could be determined",
      hint: `set model.baseUrl; the "${providerId ?? "openai-compatible"}" preset has no default because the endpoint is yours`,
    };
  }

  const model: Model = {
    id: modelId,
    name: config.name?.trim() || modelId,
    api,
    provider: providerId || preset?.id || "custom",
    baseUrl,
    reasoning: config.reasoning === true,
    input: config.input?.length ? [...config.input] : ["text"],
    // Zeros mean "not priced". Pricing belongs to the desktop model catalog;
    // copying a table here would go stale and report wrong costs.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: positiveInteger(config.maxTokens) ?? DEFAULT_MAX_TOKENS,
    ...(positiveInteger(config.contextWindow) === undefined
      ? {}
      : { contextWindow: positiveInteger(config.contextWindow) }),
    ...(config.headers && Object.keys(config.headers).length > 0
      ? { headers: { ...config.headers } }
      : {}),
    ...(config.authHeader === undefined ? {} : { authHeader: config.authHeader }),
  };

  return {
    ok: true,
    value: {
      model,
      ...(preset ? { preset } : { preset: undefined }),
      apiKeyEnvVars: preset ? [...preset.apiKeyEnvVars] : [],
    },
  };
}

/** One-line description for `doctor` and the chat banner. */
export function describeModel(model: Model): string {
  return `${model.provider}/${model.id} via ${model.api}`;
}
