import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  COMMANDS,
  EXIT_OK,
  EXIT_UNHEALTHY,
  EXIT_USAGE,
  resolvePathsForCli,
  runCli,
} from "./main.ts";
import { parseArgv } from "./argv.ts";
import { CAPABILITY_IDS } from "../capability/ledger.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "clawagent-cli-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Captures both streams so assertions can keep stdout and stderr apart. */
function harness() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

/**
 * Runs the CLI in a throwaway state directory.
 *
 * Every test goes through this. Without it, a run would resolve the real
 * `~/.clawagent` and write logs and directories into the developer's home.
 */
function run(argv: readonly string[], overrides: { env?: NodeJS.ProcessEnv } = {}) {
  const sink = harness();
  const home = tempDir();
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: "/nonexistent-dir", ...overrides.env };
  const result = runCli({
    argv,
    stdout: sink.stdout,
    stderr: sink.stderr,
    env,
    version: "9.9.9-test",
  });
  return { ...result, home, out: sink.text(), err: sink.errText() };
}

describe("version", () => {
  it("prints the injected version", () => {
    const result = run(["version"]);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.out).toContain("clawagent 9.9.9-test");
    expect(result.out).toContain("node ");
  });

  it("answers the --version flag identically", () => {
    expect(run(["--version"]).out).toContain("clawagent 9.9.9-test");
    expect(run(["-V"]).out).toContain("clawagent 9.9.9-test");
  });

  it("emits parseable JSON with --json", () => {
    const result = run(["version", "--json"]);
    expect(JSON.parse(result.out)).toMatchObject({ clawagent: "9.9.9-test" });
  });

  it("does not create a state directory", () => {
    // Printing a version must not touch the filesystem.
    const result = run(["version"]);
    expect(existsSync(path.join(result.home, ".clawagent"))).toBe(false);
    expect(existsSync(path.join(result.home, "state"))).toBe(false);
  });
});

describe("help", () => {
  it("lists every command with no arguments", () => {
    const result = run([]);
    expect(result.exitCode).toBe(EXIT_OK);
    for (const command of COMMANDS) {
      expect(result.out).toContain(command.name);
    }
  });

  it("answers --help", () => {
    expect(run(["--help"]).out).toContain("Usage: clawagent");
  });

  it("shows a command's own flags", () => {
    const result = run(["help", "doctor"]);
    expect(result.out).toContain("--skip-battery");
    expect(result.out).toContain("--storage-path");
  });

  it("falls back to the overview for an unknown help topic", () => {
    expect(run(["help", "nope"]).out).toContain("Unknown command: nope");
  });
});

describe("usage errors", () => {
  it("exits 2 for an unknown command", () => {
    const result = run(["frobnicate"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.err).toContain("unknown command");
  });

  it("exits 2 for an unknown flag", () => {
    const result = run(["doctor", "--nope"]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.err).toContain("unknown flag");
  });

  it("prints usage alongside the error", () => {
    // The user is on a phone and cannot tab-complete; show them the way out.
    expect(run(["frobnicate"]).err).toContain("Usage: clawagent");
  });

  it("suggests the nearest command for a typo", () => {
    expect(run(["doctr"]).err).toContain('did you mean "doctor"?');
  });

  it("keeps usage errors off stdout", () => {
    expect(run(["frobnicate"]).out).toBe("");
  });

  it("separates the three exit codes", () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_UNHEALTHY).toBe(1);
    expect(EXIT_USAGE).toBe(2);
  });
});

describe("doctor", () => {
  it("runs and reports through stdout", () => {
    const result = run(["doctor", "--skip-battery"]);
    expect([EXIT_OK, EXIT_UNHEALTHY]).toContain(result.exitCode);
    expect(result.out).toContain("ClawAgent doctor");
  });

  it("honours --home", () => {
    const home = tempDir();
    const result = run(["doctor", "--skip-battery", "--home", home]);
    expect(result.out).toContain(home);
    expect(existsSync(path.join(home, "state"))).toBe(true);
  });

  it("lets --home win over CLAWAGENT_HOME", () => {
    const fromEnv = tempDir();
    const fromFlag = tempDir();
    const result = run(["doctor", "--skip-battery", "--home", fromFlag], {
      env: { CLAWAGENT_HOME: fromEnv },
    });
    expect(result.out).toContain(fromFlag);
    expect(result.out).not.toContain(fromEnv);
  });

  it("writes a JSON Lines log file", () => {
    const home = tempDir();
    run(["doctor", "--skip-battery", "--home", home]);
    const log = path.join(home, "logs", "clawagent.log");
    expect(existsSync(log)).toBe(true);
    const records = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { scope: string });
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]?.scope).toBe("cli");
  });

  it("emits debug lines only when asked", () => {
    const quiet = run(["doctor", "--skip-battery"]);
    expect(quiet.err).not.toContain("doctor starting");
    expect(quiet.err).toContain("doctor finished");

    const verbose = run(["doctor", "--skip-battery", "--log-level", "debug"]);
    expect(verbose.err).toContain("doctor starting");
  });

  it("produces parseable JSON covering every capability", () => {
    const home = tempDir();
    const result = run(["doctor", "--json", "--skip-battery", "--home", home]);
    const report = JSON.parse(result.out) as {
      startable: boolean;
      capabilities: { id: string }[];
      paths: { home: string };
    };
    expect(report.paths.home).toBe(home);
    expect(report.capabilities.map((entry) => entry.id).sort()).toEqual([...CAPABILITY_IDS].sort());
    expect(result.exitCode).toBe(report.startable ? EXIT_OK : EXIT_UNHEALTHY);
  });

  it("keeps stdout parseable by sending logs to stderr", () => {
    // A single stray log line on stdout would break `doctor --json | jq`, which
    // is how CI and later tooling read this.
    const result = run(["doctor", "--json", "--skip-battery", "--log-level", "debug"]);
    expect(() => JSON.parse(result.out)).not.toThrow();
    expect(result.err).toContain("doctor starting");
  });

  it("accepts --storage-path", () => {
    const target = tempDir();
    const result = run(["doctor", "--json", "--skip-battery", "--storage-path", target]);
    const report = JSON.parse(result.out) as { facts: { storage: { path: string } } };
    expect(report.facts.storage.path).toBe(target);
  });

  it("reports the Termux host when the environment says so", () => {
    const result = run(["doctor", "--skip-battery"], {
      env: { PREFIX: "/data/data/com.termux/files/usr", ANDROID_DATA: "/data" },
    });
    expect(result.out).toContain("host: Termux");
    expect(result.out).toContain("Reading these numbers on Android");
  });

  it("says plainly when it is not running on a phone", () => {
    expect(run(["doctor", "--skip-battery"]).out).toContain("not a phone");
  });
});

describe("resolvePathsForCli", () => {
  it("applies the --home flag", () => {
    const home = tempDir();
    const parsed = parseArgv(["doctor", "--home", home], COMMANDS);
    expect(resolvePathsForCli(parsed, {})?.home).toBe(home);
  });

  it("falls back to the environment", () => {
    const home = tempDir();
    const parsed = parseArgv(["doctor"], COMMANDS);
    expect(resolvePathsForCli(parsed, { CLAWAGENT_HOME: home })?.home).toBe(home);
  });

  it("ignores blank environment values and still resolves a home", () => {
    // Blank HOME/USERPROFILE must not produce a "." path; os.homedir() is the
    // last resort. The fully-unresolvable case is covered in paths.test.ts,
    // where the homedir function itself can be injected.
    const parsed = parseArgv(["doctor"], COMMANDS);
    const paths = resolvePathsForCli(parsed, { HOME: "", USERPROFILE: "" });
    expect(paths).toBeTruthy();
    expect(path.isAbsolute(paths?.home ?? "")).toBe(true);
  });
});
