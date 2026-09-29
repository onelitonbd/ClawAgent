import { describe, expect, it } from "vitest";
import { GLOBAL_FLAGS, parseArgv, renderUsage, suggestCommand } from "./argv.ts";
// The command table lives with the entry point; the parser is generic.
import { COMMANDS, DOCTOR_COMMAND } from "./main.ts";

function parse(argv: readonly string[]) {
  return parseArgv(argv, COMMANDS);
}

describe("parseArgv command selection", () => {
  it("resolves a known command", () => {
    expect(parse(["doctor"]).command).toBe("doctor");
  });

  it("is case-insensitive about the command name", () => {
    expect(parse(["DOCTOR"]).command).toBe("doctor");
  });

  it("leaves command absent when only flags are given", () => {
    const result = parse(["--json"]);
    expect(result.command).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it("collects operands after the command", () => {
    const result = parse(["help", "doctor"]);
    expect(result.command).toBe("help");
    expect(result.positionals).toEqual(["doctor"]);
  });

  it("reports an unknown command as an error rather than throwing", () => {
    const result = parse(["frobnicate"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("unknown command");
  });
});

describe("parseArgv flags", () => {
  it("reads a boolean long flag", () => {
    expect(parse(["doctor", "--json"]).flags.json).toBe(true);
  });

  it("reads a boolean short flag", () => {
    expect(parse(["-h"]).help).toBe(true);
  });

  it("reads a string flag with an inline value", () => {
    expect(parse(["--log-level=debug"]).flags["log-level"]).toBe("debug");
  });

  it("reads a string flag from the next token", () => {
    expect(parse(["--log-level", "warn"]).flags["log-level"]).toBe("warn");
  });

  it("accepts a value that looks like a path", () => {
    expect(parse(["--home", "/data/data/com.termux/files/home/.clawagent"]).flags.home).toBe(
      "/data/data/com.termux/files/home/.clawagent",
    );
  });

  it("errors when a string flag has no value", () => {
    expect(parse(["--log-level"]).errors.join()).toContain("requires a value");
  });

  it("errors when a string flag is followed by another flag", () => {
    // Consuming `--json` as the value of `--log-level` would silently drop a flag.
    const result = parse(["--log-level", "--json"]);
    expect(result.errors.join()).toContain("requires a value");
    expect(result.flags["log-level"]).toBeUndefined();
  });

  it("errors on an unknown flag", () => {
    expect(parse(["doctor", "--nonsense"]).errors.join()).toContain("unknown flag: --nonsense");
  });

  it("resolves a command-specific flag", () => {
    expect(parse(["doctor", "--skip-battery"]).flags["skip-battery"]).toBe(true);
  });

  it("rejects another command's flag before the command is known", () => {
    // `--skip-battery` belongs to doctor; at global scope it is not defined.
    expect(parse(["--skip-battery", "doctor"]).errors.join()).toContain("unknown flag");
  });

  it("negates a boolean with --no-", () => {
    expect(parse(["doctor", "--json", "--no-json"]).flags.json).toBe(false);
  });

  it("accepts an explicit boolean value", () => {
    expect(parse(["--json=false"]).flags.json).toBe(false);
    expect(parse(["--json=true"]).flags.json).toBe(true);
  });

  it("rejects a non-boolean value for a boolean flag", () => {
    expect(parse(["--json=maybe"]).errors.join()).toContain("expects true or false");
  });

  it("treats everything after -- as an operand", () => {
    const result = parse(["help", "--", "--json", "-h"]);
    expect(result.positionals).toEqual(["--json", "-h"]);
    expect(result.errors).toEqual([]);
  });

  it("does not treat a lone dash as a flag", () => {
    const result = parse(["help", "-"]);
    expect(result.positionals).toEqual(["-"]);
    expect(result.errors).toEqual([]);
  });

  it("reports help and version", () => {
    expect(parse(["--help"]).help).toBe(true);
    expect(parse(["-V"]).version).toBe(true);
    expect(parse(["version"]).version).toBe(false);
  });

  it("collects every error instead of stopping at the first", () => {
    // On a phone a single run should surface all the mistakes, not one at a time.
    const result = parse(["--nope", "--log-level", "--also-nope", "doctor"]);
    expect(result.errors.length).toBe(3);
    expect(result.command).toBe("doctor");
  });
});

describe("suggestCommand", () => {
  it("suggests on a short prefix", () => {
    expect(suggestCommand("doc", COMMANDS)).toBe("doctor");
  });

  it("suggests on a transposition", () => {
    expect(suggestCommand("doctr", COMMANDS)).toBe("doctor");
  });

  it("returns an exact match unchanged", () => {
    expect(suggestCommand("version", COMMANDS)).toBe("version");
  });

  it("refuses to guess when nothing is close", () => {
    // A confident wrong suggestion is worse than none.
    expect(suggestCommand("zzzzzzzzzzzz", COMMANDS)).toBeUndefined();
  });

  it("does not suggest from a single character prefix", () => {
    expect(suggestCommand("d", COMMANDS)).toBeUndefined();
  });
});

describe("renderUsage", () => {
  it("lists every command", () => {
    const usage = renderUsage(COMMANDS).join("\n");
    for (const command of COMMANDS) {
      expect(usage).toContain(command.name);
    }
  });

  it("shows global flags", () => {
    const usage = renderUsage(COMMANDS).join("\n");
    for (const flag of GLOBAL_FLAGS) {
      expect(usage, `missing --${flag.name}`).toContain(`--${flag.name}`);
    }
  });

  it("shows command-specific flags for one command", () => {
    const usage = renderUsage(COMMANDS, "doctor").join("\n");
    expect(usage).toContain("Usage: clawagent doctor");
    for (const flag of DOCTOR_COMMAND.flags ?? []) {
      expect(usage).toContain(`--${flag.name}`);
    }
  });

  it("falls back to top-level usage for an unknown command", () => {
    const usage = renderUsage(COMMANDS, "nope");
    expect(usage[0]).toContain("Unknown command: nope");
    expect(usage.join("\n")).toContain("Commands:");
  });

  it("gives every flag a description", () => {
    for (const command of COMMANDS) {
      for (const flag of command.flags ?? []) {
        expect(flag.description, `${command.name} --${flag.name}`).toBeTruthy();
      }
    }
    for (const flag of GLOBAL_FLAGS) {
      expect(flag.description, `--${flag.name}`).toBeTruthy();
    }
  });
});
