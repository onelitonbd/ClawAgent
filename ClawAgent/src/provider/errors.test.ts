// Provider error classification.
//
// Each case is a message shape that actually occurs, taken from the vendor SDKs
// and from what a mobile network produces. The contract that matters: the
// provider's own text is never replaced, only annotated.

import { describe, expect, it } from "vitest";
import { explainTurnError, renderTurnError } from "./errors.ts";
import { fakeModel } from "../../test/chat-support.ts";

const model = fakeModel({ id: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com/v1" });

describe("explainTurnError", () => {
  it.each([
    ["Connection error.", "network"],
    ["fetch failed", "network"],
    ["getaddrinfo ENOTFOUND api.anthropic.com", "network"],
    ["socket hang up", "network"],
    ["ECONNRESET while streaming", "network"],
  ])("classifies %j as a network failure", (message, kind) => {
    expect(explainTurnError(message, model).kind).toBe(kind);
  });

  it.each([
    ["401 invalid x-api-key", "auth"],
    ["Unauthorized", "auth"],
    ["403 Forbidden", "auth"],
    ["Incorrect API key provided", "auth"],
  ])("classifies %j as an auth failure", (message, kind) => {
    expect(explainTurnError(message, model).kind).toBe(kind);
  });

  it.each([
    ["429 Too Many Requests", "rate-limit"],
    ["Overloaded, please retry", "rate-limit"],
    ["Quota exceeded for this project", "rate-limit"],
  ])("classifies %j as rate limiting", (message, kind) => {
    expect(explainTurnError(message, model).kind).toBe(kind);
  });

  it.each([
    ["model 'claude-nope' not found", "model"],
    ["404 Unknown model", "model"],
  ])("classifies %j as a model problem", (message, kind) => {
    expect(explainTurnError(message, model).kind).toBe(kind);
  });

  it("prefers abort over the connection reset it often surfaces as", () => {
    expect(explainTurnError("The operation was aborted", model).kind).toBe("aborted");
  });

  it("prefers auth over a network word inside a 401 body", () => {
    expect(explainTurnError("401 network policy rejected the key", model).kind).toBe("auth");
  });

  it("leaves an unrecognised message unclassified rather than guessing", () => {
    const explained = explainTurnError("the provider said something unusual", model);
    expect(explained.kind).toBe("unknown");
    expect(explained.hint).toBeUndefined();
  });

  it("always keeps the provider's own message", () => {
    for (const message of ["Connection error.", "401 unauthorized", "weird"]) {
      expect(explainTurnError(message, model).message).toBe(message);
    }
  });

  it("names the endpoint in a network hint", () => {
    const explained = explainTurnError("Connection error.", model);
    expect(explained.hint).toContain("https://api.anthropic.com/v1");
    expect(explained.hint).toContain("mobile data");
  });

  it("names the model id when the provider rejects it", () => {
    expect(explainTurnError("404 model not found", model).hint).toContain("claude-sonnet-4-5");
  });

  it("works without a model, for a failure before routing", () => {
    const explained = explainTurnError("Connection error.");
    expect(explained.kind).toBe("network");
    expect(explained.hint).toContain("could not reach");
  });

  it("substitutes a message when there is none", () => {
    expect(explainTurnError("   ", model).message).toBe("the turn failed without a message");
  });
});

describe("renderTurnError", () => {
  it("puts the hint on its own indented line", () => {
    const lines = renderTurnError(explainTurnError("Connection error.", model));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("error: Connection error.");
    expect(lines[1]).toMatch(/^\s+the device could not reach/u);
  });

  it("prints only the message when there is no hint", () => {
    expect(renderTurnError(explainTurnError("something unusual", model))).toEqual([
      "error: something unusual",
    ]);
  });
});
