// API key resolution.
//
// Two properties matter more than the happy path: precedence (a user who sets
// `CLAWAGENT_API_KEY` for one command must not get the key from their shell
// profile instead) and silence (nothing here may print or store a whole key).

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_KEYS_FILE_NAME,
  describeApiKey,
  readCredentialsFile,
  resolveApiKey,
} from "./api-key.ts";
import { ENV_OVERRIDES } from "../config/config.ts";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clawagent-keys-"));
  created.push(dir);
  return dir;
}

function credentialsDirWith(content: string, mode = 0o600): string {
  const dir = tempDir();
  const file = path.join(dir, API_KEYS_FILE_NAME);
  writeFileSync(file, content);
  chmodSync(file, mode);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("resolveApiKey precedence", () => {
  const envVars = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_API_KEY"];

  it("prefers the explicit per-invocation override", () => {
    const dir = credentialsDirWith(JSON.stringify({ anthropic: "from-file" }));
    const result = resolveApiKey({
      provider: "anthropic",
      envVars,
      credentialsDir: dir,
      env: { [ENV_OVERRIDES.apiKey]: "from-override", ANTHROPIC_API_KEY: "from-env" },
    });
    expect(result).toMatchObject({
      key: "from-override",
      source: "override-env",
      foundIn: ENV_OVERRIDES.apiKey,
    });
  });

  it("prefers the credentials file over a shell-profile variable", () => {
    // The file is a deliberate choice about this device; an exported variable is
    // often left over from something else entirely.
    const dir = credentialsDirWith(JSON.stringify({ anthropic: "from-file" }));
    const result = resolveApiKey({
      provider: "anthropic",
      envVars,
      credentialsDir: dir,
      env: { ANTHROPIC_API_KEY: "from-env" },
    });
    expect(result).toMatchObject({ key: "from-file", source: "credentials-file" });
    expect(result.foundIn).toBe(path.join(dir, API_KEYS_FILE_NAME));
  });

  it("falls back to the first conventional variable that is set", () => {
    const result = resolveApiKey({
      provider: "google",
      envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      env: { GOOGLE_API_KEY: "google-key" },
    });
    expect(result).toMatchObject({
      key: "google-key",
      source: "provider-env",
      foundIn: "GOOGLE_API_KEY",
    });
  });

  it("honours the declared order of conventional variables", () => {
    const result = resolveApiKey({
      provider: "google",
      envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      env: { GEMINI_API_KEY: "gemini-key", GOOGLE_API_KEY: "google-key" },
    });
    expect(result.foundIn).toBe("GEMINI_API_KEY");
  });

  it("trims surrounding whitespace from a pasted key", () => {
    // Copy/paste from a phone browser routinely drags a newline along.
    const result = resolveApiKey({
      provider: "anthropic",
      envVars,
      env: { ANTHROPIC_API_KEY: "  sk-ant-123\n" },
    });
    expect(result.key).toBe("sk-ant-123");
  });

  it("reports nothing found, naming every way to fix it", () => {
    const result = resolveApiKey({
      provider: "anthropic",
      envVars,
      env: {},
      modelId: "claude-sonnet-4-5",
    });
    expect(result.key).toBeUndefined();
    expect(result.source).toBe("none");
    expect(result.problems).toHaveLength(1);
    const problem = result.problems[0] ?? "";
    expect(problem).toContain("anthropic/claude-sonnet-4-5");
    expect(problem).toContain("export ANTHROPIC_API_KEY=...");
    expect(problem).toContain("export CLAUDE_CODE_API_KEY=...");
    expect(problem).toContain(`export ${ENV_OVERRIDES.apiKey}=...`);
    expect(problem).toContain(API_KEYS_FILE_NAME);
  });

  it("still works for a provider with no conventional variables", () => {
    // A bring-your-own endpoint has no vendor variable to suggest.
    const result = resolveApiKey({ provider: "custom", env: {} });
    expect(result.source).toBe("none");
    expect(result.problems[0]).toContain(`export ${ENV_OVERRIDES.apiKey}=...`);
  });
});

describe("readCredentialsFile", () => {
  it("returns undefined when there is no file", () => {
    expect(readCredentialsFile(tempDir(), "anthropic")).toBeUndefined();
  });

  it("returns undefined when there is no credentials directory", () => {
    expect(readCredentialsFile(undefined, "anthropic")).toBeUndefined();
  });

  it("reads a bare string value", () => {
    const dir = credentialsDirWith(JSON.stringify({ anthropic: "sk-ant-abc" }));
    expect(readCredentialsFile(dir, "anthropic")?.key).toBe("sk-ant-abc");
  });

  it.each([
    ["apiKey", "nested apiKey"],
    ["api_key", "nested api_key"],
    ["key", "nested key"],
  ])("reads an object with a %s field", (field, expected) => {
    const dir = credentialsDirWith(JSON.stringify({ anthropic: { [field]: expected } }));
    expect(readCredentialsFile(dir, "anthropic")?.key).toBe(expected);
  });

  it("returns no key for an unlisted provider without reporting a problem", () => {
    const dir = credentialsDirWith(JSON.stringify({ openai: "sk-openai" }));
    const result = readCredentialsFile(dir, "anthropic");
    expect(result?.key).toBeUndefined();
    expect(result?.problems).toEqual([]);
  });

  it("reports malformed JSON", () => {
    const dir = credentialsDirWith("{ not json");
    const result = readCredentialsFile(dir, "anthropic");
    expect(result?.key).toBeUndefined();
    expect(result?.problems[0]).toContain("not valid JSON");
  });

  it("reports a JSON array", () => {
    const dir = credentialsDirWith('["sk-nope"]');
    expect(readCredentialsFile(dir, "anthropic")?.problems[0]).toContain(
      "must be a JSON object keyed by provider id",
    );
  });

  it("warns when the file is readable by others", () => {
    // A state root on shared storage is not private, and a world-readable key
    // file is a real leak rather than a style complaint.
    const dir = credentialsDirWith(JSON.stringify({ anthropic: "sk-ant-abc" }), 0o644);
    const result = readCredentialsFile(dir, "anthropic");
    expect(result?.key).toBe("sk-ant-abc");
    expect(result?.problems[0]).toContain("readable by others");
    expect(result?.problems[0]).toContain("chmod 600");
  });

  it("says nothing about a private file", () => {
    const dir = credentialsDirWith(JSON.stringify({ anthropic: "sk-ant-abc" }), 0o600);
    expect(readCredentialsFile(dir, "anthropic")?.problems).toEqual([]);
  });

  it("surfaces the mode warning through resolution", () => {
    const dir = credentialsDirWith(JSON.stringify({ anthropic: "sk-ant-abc" }), 0o666);
    const result = resolveApiKey({
      provider: "anthropic",
      credentialsDir: dir,
      env: {},
    });
    expect(result.key).toBe("sk-ant-abc");
    expect(result.problems[0]).toContain("readable by others");
  });
});

describe("describeApiKey", () => {
  it("masks the key and names where it came from", () => {
    const text = describeApiKey({
      key: "sk-ant-api03-ABCDEFGHIJKLMNOP",
      source: "provider-env",
      foundIn: "ANTHROPIC_API_KEY",
      problems: [],
    });
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("MNOP");
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("ABCDEFGHIJKLMNOP");
  });

  it("says plainly when there is no key", () => {
    expect(describeApiKey({ key: undefined, source: "none", problems: [] })).toBe(
      "not configured",
    );
  });
});
