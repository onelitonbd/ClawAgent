// Provider routing presets.
//
// These hold only facts that are stable and boring: which protocol adapter a
// provider speaks, its base URL, and the environment variable names its key is
// conventionally found in. Everything a user is likely to change (model id,
// token budget, temperature) comes from config instead.
//
// What is deliberately NOT here: pricing and context-window tables. Those belong
// to the model catalog the desktop host owns, they change often, and a stale copy
// on a phone would quietly report wrong costs. `cost` defaults to zeros, which
// reads as "not priced" rather than "free".

/** Protocol adapters that `@openclaw/ai` registers as built-ins. */
export const KNOWN_APIS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
  "mistral-conversations",
] as const;

export type KnownApiId = (typeof KNOWN_APIS)[number];

export type ProviderPreset = {
  /** Config-facing provider id. */
  id: string;
  /** Protocol adapter to route through. */
  api: KnownApiId;
  /** Default base URL; overridable for proxies and self-hosted gateways. */
  baseUrl: string;
  /** Environment variables checked for an API key, in priority order. */
  apiKeyEnvVars: string[];
  /** Human name for help output. */
  label: string;
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnvVars: ["ANTHROPIC_API_KEY"],
    label: "Anthropic Claude",
  },
  {
    id: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvVars: ["OPENAI_API_KEY"],
    label: "OpenAI",
  },
  {
    id: "openai-completions",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvVars: ["OPENAI_API_KEY"],
    label: "OpenAI (chat completions protocol)",
  },
  {
    id: "google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    label: "Google Gemini",
  },
  {
    id: "mistral",
    api: "mistral-conversations",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnvVars: ["MISTRAL_API_KEY"],
    label: "Mistral",
  },
  {
    // Not a vendor: any endpoint speaking the OpenAI chat-completions protocol.
    // This is the preset that matters most on a phone, because it is how a local
    // or proxied model gets used without a new adapter.
    id: "openai-compatible",
    api: "openai-completions",
    baseUrl: "",
    apiKeyEnvVars: ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"],
    label: "Any OpenAI-compatible endpoint (set baseUrl)",
  },
];

/** Looks up a preset by id. */
export function findProviderPreset(id: string): ProviderPreset | undefined {
  const normalized = id.trim().toLowerCase();
  return PROVIDER_PRESETS.find((preset) => preset.id === normalized);
}

/** Provider ids for help and error messages. */
export function providerPresetIds(): string[] {
  return PROVIDER_PRESETS.map((preset) => preset.id);
}
