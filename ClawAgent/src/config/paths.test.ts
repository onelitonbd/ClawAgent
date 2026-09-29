import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FILE_NAME,
  DEFAULT_STATE_DIR_NAME,
  agentDir,
  agentSessionsDir,
  describeClawAgentPaths,
  isValidAgentId,
  logFilePath,
  normalizeAgentId,
  normalizeHomeDirValue,
  resolveClawAgentHome,
  resolveClawAgentPaths,
  resolveDefaultClawAgentPaths,
  resolveOsHomeDir,
} from "./paths.ts";

/** A homedir stub that fails loudly if anything falls back to it. */
function forbiddenHomedir(): string {
  throw new Error("os.homedir() must not be consulted for this case");
}

describe("normalizeHomeDirValue", () => {
  it.each([
    ["/home/user", "/home/user"],
    ["  /home/user  ", "/home/user"],
    ["", undefined],
    ["   ", undefined],
    ["undefined", undefined],
    ["null", undefined],
    [undefined, undefined],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeHomeDirValue(input)).toBe(expected);
  });
});

describe("resolveOsHomeDir", () => {
  it("prefers HOME", () => {
    expect(resolveOsHomeDir({ HOME: "/home/user" }, forbiddenHomedir)).toBe("/home/user");
  });

  it("falls back to USERPROFILE", () => {
    expect(resolveOsHomeDir({ USERPROFILE: "/profile" }, forbiddenHomedir)).toBe("/profile");
  });

  it("derives the Termux home from PREFIX when HOME is unset", () => {
    const env = { PREFIX: "/data/data/com.termux/files/usr", ANDROID_DATA: "/data" };
    expect(resolveOsHomeDir(env, forbiddenHomedir)).toBe("/data/data/com.termux/files/home");
  });

  it("returns undefined rather than throwing when nothing resolves", () => {
    expect(
      resolveOsHomeDir({}, () => {
        throw new Error("no home");
      }),
    ).toBeUndefined();
  });
});

describe("resolveClawAgentHome", () => {
  it("defaults to a directory under the OS home", () => {
    expect(resolveClawAgentHome({ HOME: "/home/user" }, forbiddenHomedir)).toBe(
      path.join("/home/user", DEFAULT_STATE_DIR_NAME),
    );
  });

  it("honours an absolute CLAWAGENT_HOME", () => {
    expect(resolveClawAgentHome({ CLAWAGENT_HOME: "/data/local/state" }, forbiddenHomedir)).toBe(
      "/data/local/state",
    );
  });

  it("overrides the OS home entirely, without appending the default name", () => {
    const home = resolveClawAgentHome(
      { HOME: "/home/user", CLAWAGENT_HOME: "/custom" },
      forbiddenHomedir,
    );
    expect(home).toBe("/custom");
  });

  it("expands a leading tilde against the OS home", () => {
    expect(resolveClawAgentHome({ HOME: "/home/user", CLAWAGENT_HOME: "~/agent" }, forbiddenHomedir)).toBe(
      "/home/user/agent",
    );
  });

  it("expands a bare tilde to the OS home", () => {
    expect(resolveClawAgentHome({ HOME: "/home/user", CLAWAGENT_HOME: "~" }, forbiddenHomedir)).toBe(
      "/home/user",
    );
  });

  it("returns undefined for an unresolvable tilde instead of creating a '~' directory", () => {
    expect(
      resolveClawAgentHome({ CLAWAGENT_HOME: "~/agent" }, () => {
        throw new Error("no home");
      }),
    ).toBeUndefined();
  });

  it("ignores a blank CLAWAGENT_HOME", () => {
    expect(resolveClawAgentHome({ HOME: "/home/user", CLAWAGENT_HOME: "   " }, forbiddenHomedir)).toBe(
      path.join("/home/user", DEFAULT_STATE_DIR_NAME),
    );
  });

  it("works on Termux with HOME unset", () => {
    const env = { PREFIX: "/data/data/com.termux/files/usr", ANDROID_DATA: "/data" };
    expect(resolveClawAgentHome(env, forbiddenHomedir)).toBe(
      "/data/data/com.termux/files/home/.clawagent",
    );
  });
});

describe("resolveClawAgentPaths", () => {
  const paths = resolveClawAgentPaths("/home/user/.clawagent");

  it("places the config file at the state root", () => {
    expect(paths.configFile).toBe(`/home/user/.clawagent/${CONFIG_FILE_NAME}`);
  });

  it("places the session database under state/", () => {
    expect(paths.sessionDatabase).toBe("/home/user/.clawagent/state/clawagent.sqlite");
  });

  it("keeps every path inside the state root", () => {
    // A stray path outside the root is how a phone ends up writing to shared
    // storage, where Android blocks it.
    const values = Object.values(paths).filter(
      (value): value is string => typeof value === "string",
    );
    for (const value of values) {
      expect(value.startsWith("/home/user/.clawagent")).toBe(true);
    }
  });

  it("splits media into inbound and outbound", () => {
    expect(paths.mediaInboundDir).toBe(path.join(paths.mediaDir, "inbound"));
    expect(paths.mediaOutboundDir).toBe(path.join(paths.mediaDir, "outbound"));
  });

  it("has a lock file for single-gateway enforcement", () => {
    expect(paths.lockFile).toBe("/home/user/.clawagent/gateway.lock");
  });

  it("describes the layout for doctor", () => {
    const lines = describeClawAgentPaths(paths);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.join("\n")).toContain(paths.sessionDatabase);
  });
});

describe("resolveDefaultClawAgentPaths", () => {
  it("returns undefined when no home can be resolved", () => {
    expect(
      resolveDefaultClawAgentPaths({}, () => {
        throw new Error("no home");
      }),
    ).toBeUndefined();
  });
});

describe("agent ids", () => {
  it.each([
    ["main", "main"],
    ["Main", "main"],
    ["agent-1", "agent-1"],
    ["agent_1", "agent_1"],
    ["../../etc/passwd", "etc-passwd"],
    ["..", undefined],
    ["", undefined],
    ["   ", undefined],
    ["---", undefined],
    ["has space", "has-space"],
    ["has.dot", "has-dot"],
  ])("normalizeAgentId(%j) === %j", (input, expected) => {
    expect(normalizeAgentId(input)).toBe(expected);
  });

  it.each([["main", true], ["Main", true], ["agent-1", true], ["", false], ["..", false], ["a.b", false]])(
    "isValidAgentId(%j) === %s",
    (input, expected) => {
      expect(isValidAgentId(input)).toBe(expected);
    },
  );

  it("truncates to 64 characters", () => {
    expect(normalizeAgentId("a".repeat(200))).toHaveLength(64);
  });

  it("never produces a directory outside agents/", () => {
    const paths = resolveClawAgentPaths("/state");
    const hostile = ["..", "../..", "../../etc", "/", "a/../../b", "\\..\\windows"];
    for (const id of hostile) {
      const dir = agentDir(paths, id);
      if (dir === undefined) {
        continue;
      }
      // Resolving must not escape the agents directory.
      expect(path.relative(paths.agentsDir, dir).startsWith("..")).toBe(false);
      expect(dir.startsWith(`${paths.agentsDir}${path.sep}`)).toBe(true);
    }
  });

  it("places sessions under the agent directory", () => {
    const paths = resolveClawAgentPaths("/state");
    expect(agentSessionsDir(paths, "main")).toBe(path.join(paths.agentsDir, "main", "sessions"));
  });

  it("returns undefined for an unusable id rather than defaulting", () => {
    // A silent "main" fallback would route a stranger's message into the main
    // agent's history.
    const paths = resolveClawAgentPaths("/state");
    expect(agentDir(paths, "!!!")).toBeUndefined();
  });
});

describe("logFilePath", () => {
  it("sanitizes a hostile log name", () => {
    const paths = resolveClawAgentPaths("/state");
    const resolved = logFilePath(paths, "../../etc/passwd");
    // The separator is what enables traversal, so the file must stay a direct
    // child of logs/. A literal ".." inside a filename is inert.
    expect(path.dirname(resolved)).toBe(paths.logsDir);
    expect(resolved.endsWith(".log")).toBe(true);
  });

  it("keeps ordinary names readable", () => {
    const paths = resolveClawAgentPaths("/state");
    expect(logFilePath(paths, "clawagent")).toBe(path.join(paths.logsDir, "clawagent.log"));
  });
});
