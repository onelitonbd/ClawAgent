// Turning provider failures into something a person can act on.
//
// On a phone the two most common failures are a network that is not really there
// (mobile data off, captive portal, proxy, DNS) and a key that is wrong or
// expired. The vendor SDKs report both in a few opaque words — the Anthropic SDK
// says exactly "Connection error." — which sends the user to check the wrong
// thing. This maps the recognisable shapes onto the check that matters, without
// hiding the original message.
//
// Purely additive: the provider's own text is always kept, so nothing here can
// make a diagnosis worse by guessing wrong.

import type { Model } from "@openclaw/llm-core";

/** A failure plus the check it most likely points at. */
export type ExplainedError = {
  /** The provider's own message. */
  message: string;
  /** What to look at, when the message matches a known shape. */
  hint: string | undefined;
  /** Coarse class, for logs and tests. */
  kind: "network" | "auth" | "rate-limit" | "model" | "aborted" | "unknown";
};

const NETWORK_PATTERN =
  /connection error|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|network|socket hang up|terminated|unable to connect|getaddrinfo/iu;
const AUTH_PATTERN =
  /\b40[13]\b|invalid[ _-]?(?:api[ _-]?)?key|unauthoriz|forbidden|authentication|permission denied|incorrect api key|invalid x-api-key/iu;
const RATE_LIMIT_PATTERN = /\b429\b|rate limit|too many requests|overloaded|quota/iu;
const MODEL_PATTERN =
  /\b40[04]\b|not found|does not exist|unknown model|no such model|unsupported model|invalid model/iu;
const ABORTED_PATTERN = /abort|cancelled|canceled/iu;

function classify(message: string): ExplainedError["kind"] {
  // Order matters: a 401 body can contain the word "network", and an abort can
  // surface as a connection reset, so the more specific causes are checked first.
  if (ABORTED_PATTERN.test(message)) {
    return "aborted";
  }
  if (AUTH_PATTERN.test(message)) {
    return "auth";
  }
  if (RATE_LIMIT_PATTERN.test(message)) {
    return "rate-limit";
  }
  if (MODEL_PATTERN.test(message)) {
    return "model";
  }
  if (NETWORK_PATTERN.test(message)) {
    return "network";
  }
  return "unknown";
}

/**
 * Explains a failed turn.
 *
 * The model is used only to name the endpoint and id in the hint, which is the
 * part a user needs to compare against what they configured.
 */
export function explainTurnError(error: string, model?: Model): ExplainedError {
  const message = error.trim() || "the turn failed without a message";
  const kind = classify(message);
  const endpoint = model ? ` ${model.baseUrl}` : "";
  const hint = (() => {
    switch (kind) {
      case "aborted":
        return "interrupted locally; nothing was sent after the abort";
      case "auth":
        return `the API key was rejected — check it with \`clawagent doctor\` and the variable it came from`;
      case "rate-limit":
        return "the provider is refusing more requests right now; wait a moment and retry";
      case "model":
        return model
          ? `the provider does not recognise "${model.id}" — check the model id, and that this key can use it`
          : "the provider does not recognise that model id";
      case "network":
        return `the device could not reach${endpoint} — check mobile data or Wi-Fi, a captive portal, or a proxy`;
      default:
        return undefined;
    }
  })();
  return { message, kind, ...(hint ? { hint } : { hint: undefined }) };
}

/** Renders an explained failure as the lines a terminal should show. */
export function renderTurnError(explained: ExplainedError): string[] {
  return explained.hint
    ? [`error: ${explained.message}`, `       ${explained.hint}`]
    : [`error: ${explained.message}`];
}
