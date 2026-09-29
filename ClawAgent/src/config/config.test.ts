// Config parsing and environment overrides.
//
// The cases worth the most attention are the ones where a plausible-looking file
// must produce a *named* problem rather than a silently ignored setting: on a
// phone, `baseurl` instead of `baseUrl` otherwise surfaces two layers away as
// "no baseUrl could be determined", which reads like a broken install.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENV_OVERRIDES,
  KNOWN_CONFIG_KEYS,
  applyEnvOverrides,
  loadConfigFile,
  parseConfigJson,
  resolveConfig,
} from "./config.ts";
import { resolveClawAgentPaths } from "./paths.ts";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "clawagent-config-"));
  created.push(dir);
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

describe("parseConfigJson", () => {
  it("accepts a complete, well-formed config", () => {
    const { config, problems } = parseConfigJson(
      JSON.stringify({
        model: {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          maxTokens: 2048,
          reasoning: true,
          input: ["text", "image"],
        },
        chat: { systemPrompt: "Be brief.", temperature: 0.3, maxTokens: 512 },
      }),
    );
    expect(problems).toEqual([]);
    expect(config.model).toMatchObject({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      maxTokens: 2048,
      reasoning: true,
      input: ["text", "image"],
    });
    expect(config.chat).toMatchObject({ systemPrompt: "Be brief.", temperature: 0.3 });
  });

  it("accepts an empty object", () => {
    expect(parseConfigJson("{}")).toEqual({ config: {}, problems: [] });
  });

  it("reports malformed JSON without throwing", () => {
    const { config, problems } = parseConfigJson("{ not json");
    expect(config).toEqual({});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not valid JSON");
  });

  it("rejects a top-level array", () => {
    expect(parseConfigJson("[]").problems[0]).toContain("must be a JSON object");
  });

  it("names an unknown top-level key", () => {
    const { problems } = parseConfigJson(JSON.stringify({ modele: { id: "x" } }));
    expect(problems).toEqual(["modele is not a known setting"]);
  });

  it("names an unknown model key", () => {
    // The typo guard that makes the difference between a clear message and a
    // confusing downstream failure.
    const { problems } = parseConfigJson(
      JSON.stringify({ model: { id: "x", baseurl: "https://example.test" } }),
    );
    expect(problems).toEqual(["model.baseurl is not a known setting"]);
  });

  it("keeps every known key list honest", () => {
    expect(KNOWN_CONFIG_KEYS).toEqual(["model", "chat", "agent"]);
  });

  it.each([
    ['{"model": "anthropic"}', "model must be an object"],
    ['{"chat": []}', "chat must be an object"],
    ['{"model":{"id":42}}', "model.id must be a non-empty string"],
    ['{"model":{"id":"x","maxTokens":-1}}', "model.maxTokens must be a positive number"],
    ['{"model":{"id":"x","reasoning":"yes"}}', "model.reasoning must be true or false"],
    ['{"model":{"id":"x","input":[]}}', 'model.input must be a non-empty array of "text" or "image"'],
    ['{"model":{"id":"x","input":["video"]}}', 'model.input must be a non-empty array'],
    ['{"model":{"id":"x","headers":{"a":1}}}', "model.headers must be an object of string values"],
    ['{"model":{"id":"x","authHeader":"yes"}}', "model.authHeader must be true or false"],
    ['{"chat":{"temperature":"hot"}}', "chat.temperature must be a positive number"],
    ['{"agent": "yes"}', "agent must be an object"],
    ['{"agent":{"nope":1}}', "agent.nope is not a known setting"],
    ['{"agent":{"maxTurns":"lots"}}', "agent.maxTurns must be a positive number"],
  ])("reports %s as %s", (raw, expected) => {
    expect(parseConfigJson(raw).problems[0]).toContain(expected);
  });

  it("floors a fractional agent.maxTurns", () => {
    // A turn limit of 7.9 means "about 8"; storing 7.9 and comparing with >=
    // would let a run take 8 turns and then report the cap as a fraction.
    expect(parseConfigJson('{"agent":{"maxTurns":7.9}}').config.agent?.maxTurns).toBe(7);
  });

  it("keeps an unrecognised agent.approve as a string, for the command to reject", () => {
    // The set of legal modes belongs to the approval policy. Config stores the
    // value so `clawagent chat` still works with a bad agent section, and
    // `clawagent agent` reports it with the modes it actually accepts.
    const parsed = parseConfigJson('{"agent":{"approve":"yolo-ish"}}');
    expect(parsed.config.agent?.approve).toBe("yolo-ish");
    expect(parsed.problems).toEqual([]);
  });

  it("allows a temperature of exactly zero", () => {
    // Zero is a legitimate, meaningful setting; a naive "positive number" check
    // would drop it and quietly fall back to the provider default.
    expect(parseConfigJson('{"chat":{"temperature":0}}').config.chat?.temperature).toBe(0);
  });

  it("reports a blank string rather than silently dropping it", () => {
    // `"provider": ""` in a file is a leftover from a template, not a request to
    // use no provider. Storing nothing and saying nothing would leave the user
    // debugging a routing error two layers away.
    const { config, problems } = parseConfigJson('{"model":{"id":"x","provider":"   "}}');
    expect(problems).toEqual(["model.provider must be a non-empty string"]);
    expect(config.model?.provider).toBeUndefined();
    expect(config.model?.id).toBe("x");
  });

  it("floors fractional token counts", () => {
    expect(parseConfigJson('{"model":{"id":"x","maxTokens":100.7}}').config.model?.maxTokens).toBe(
      100,
    );
  });
});

describe("loadConfigFile", () => {
  it("treats a missing file as normal", () => {
    const result = loadConfigFile(path.join(tempDir(), "absent.json"));
    expect(result).toEqual({ config: {}, problems: [], file: undefined });
  });

  it("reads and reports the file it used", () => {
    const dir = tempDir();
    const file = path.join(dir, "clawagent.json");
    writeFileSync(file, JSON.stringify({ model: { id: "x", provider: "mistral" } }));
    const result = loadConfigFile(file);
    expect(result.file).toBe(file);
    expect(result.problems).toEqual([]);
    expect(result.config.model?.provider).toBe("mistral");
  });

  it("reports an unreadable path rather than throwing", () => {
    // A missing file is normal and reports nothing; a path that exists but cannot
    // be read as a config file is a real problem the user has to be told about.
    const dir = tempDir();
    const notAFile = path.join(dir, "clawagent.json");
    mkdirSync(notAFile);
    const result = loadConfigFile(notAFile);
    expect(result.file).toBe(notAFile);
    expect(result.problems[0]).toContain("cannot read");
  });

  it("treats an absent parent directory as no config file", () => {
    const result = loadConfigFile(path.join(tempDir(), "missing", "clawagent.json"));
    expect(result).toEqual({ config: {}, problems: [], file: undefined });
  });
});

describe("applyEnvOverrides", () => {
  it("overrides provider, model, endpoint, and adapter", () => {
    const config = applyEnvOverrides({ model: { id: "from-file" } }, {
      [ENV_OVERRIDES.provider]: "google",
      [ENV_OVERRIDES.model]: "gemini-test",
      [ENV_OVERRIDES.baseUrl]: "https://gateway.test/v1",
      [ENV_OVERRIDES.api]: "openai-completions",
    });
    expect(config.model).toEqual({
      id: "gemini-test",
      provider: "google",
      baseUrl: "https://gateway.test/v1",
      api: "openai-completions",
    });
  });

  it("ignores empty variables rather than clearing config", () => {
    // An empty export left in a shell profile is a common accident; letting it
    // win would delete the configured model with no visible cause.
    const config = applyEnvOverrides({ model: { id: "kept" } }, {
      [ENV_OVERRIDES.model]: "   ",
      [ENV_OVERRIDES.provider]: "",
    });
    expect(config.model).toEqual({ id: "kept" });
  });

  it("reports a non-numeric token budget", () => {
    const problems: string[] = [];
    applyEnvOverrides({}, { [ENV_OVERRIDES.maxTokens]: "lots" }, problems);
    expect(problems[0]).toContain(`${ENV_OVERRIDES.maxTokens} must be a positive number`);
  });

  it("reports a negative temperature", () => {
    const problems: string[] = [];
    applyEnvOverrides({}, { [ENV_OVERRIDES.temperature]: "-1" }, problems);
    expect(problems[0]).toContain("must be a number >= 0");
  });

  it("accepts a temperature of zero from the environment", () => {
    const config = applyEnvOverrides({}, { [ENV_OVERRIDES.temperature]: "0" });
    expect(config.chat?.temperature).toBe(0);
  });

  it("sets a system prompt", () => {
    const config = applyEnvOverrides({}, { [ENV_OVERRIDES.systemPrompt]: "Answer in Bengali." });
    expect(config.chat?.systemPrompt).toBe("Answer in Bengali.");
  });

  it("returns an empty config when nothing is set", () => {
    expect(applyEnvOverrides({}, {})).toEqual({});
  });
});

describe("resolveConfig", () => {
  it("reads the file from the state layout and layers the environment on top", () => {
    const home = tempDir();
    const paths = resolveClawAgentPaths(home);
    writeFileSync(
      paths.configFile,
      JSON.stringify({ model: { provider: "anthropic", id: "from-file" }, chat: { temperature: 0.9 } }),
    );
    const resolved = resolveConfig(paths, { [ENV_OVERRIDES.model]: "from-env" });
    expect(resolved.file).toBe(paths.configFile);
    expect(resolved.problems).toEqual([]);
    expect(resolved.config.model).toEqual({ provider: "anthropic", id: "from-env" });
    expect(resolved.config.chat?.temperature).toBe(0.9);
  });

  it("works with no state directory at all", () => {
    const resolved = resolveConfig(undefined, { [ENV_OVERRIDES.model]: "x" });
    expect(resolved.file).toBeUndefined();
    expect(resolved.config.model?.id).toBe("x");
  });

  it("carries file problems through to the caller", () => {
    const home = tempDir();
    const paths = resolveClawAgentPaths(home);
    writeFileSync(paths.configFile, "{ broken");
    expect(resolveConfig(paths, {}).problems[0]).toContain("not valid JSON");
  });
});
