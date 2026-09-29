import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_KEEP_ROTATIONS,
  DEFAULT_MAX_LOG_BYTES,
  LOG_LEVELS,
  createLogger,
  parseLogLevel,
  rotateLogFile,
} from "./logger.ts";

/** Captures everything a logger writes to its stream. */
function capture() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: { write: (chunk: string) => chunks.push(chunk) },
    text: () => chunks.join(""),
    lines: () => chunks.join("").split("\n").filter(Boolean),
  };
}

const tempDirs: string[] = [];
function tempDir(prefix = "clawagent-log-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A clock that advances one second per call, so timestamps are distinguishable. */
function fakeClock(startMs = Date.UTC(2026, 0, 1)) {
  let ticks = 0;
  return () => new Date(startMs + ticks++ * 1000);
}

describe("parseLogLevel", () => {
  it.each([
    ["debug", "debug"],
    ["DEBUG", "debug"],
    ["  warn  ", "warn"],
    ["error", "error"],
    ["", "info"],
    [undefined, "info"],
    ["nonsense", "info"],
  ])("parses %j", (input, expected) => {
    expect(parseLogLevel(input)).toBe(expected);
  });

  it("knows every level it accepts", () => {
    for (const level of LOG_LEVELS) {
      expect(parseLogLevel(level)).toBe(level);
    }
  });
});

describe("level filtering", () => {
  it("suppresses below the configured level", () => {
    const sink = capture();
    const logger = createLogger({ scope: "test", level: "warn", stream: sink.stream });
    logger.debug("dropped");
    logger.info("dropped");
    logger.warn("kept");
    logger.error("kept");
    expect(sink.lines()).toHaveLength(2);
    expect(sink.text()).not.toContain("dropped");
  });

  it("emits everything at debug", () => {
    const sink = capture();
    const logger = createLogger({ scope: "test", level: "debug", stream: sink.stream });
    for (const level of LOG_LEVELS) {
      logger[level](`line-${level}`);
    }
    expect(sink.lines()).toHaveLength(LOG_LEVELS.length);
  });

  it("reports enabled() consistently with what it emits", () => {
    const sink = capture();
    const logger = createLogger({ scope: "test", level: "warn", stream: sink.stream });
    expect(logger.enabled("debug")).toBe(false);
    expect(logger.enabled("warn")).toBe(true);
    expect(logger.enabled("error")).toBe(true);
  });

  it("defaults to info", () => {
    expect(createLogger({ scope: "test", stream: capture().stream }).level).toBe("info");
  });
});

describe("output formats", () => {
  it("writes human-readable lines by default", () => {
    const sink = capture();
    const logger = createLogger({
      scope: "gateway",
      stream: sink.stream,
      now: fakeClock(),
    });
    logger.info("started");
    expect(sink.text()).toBe("2026-01-01T00:00:00.000Z INFO  gateway: started\n");
  });

  it("writes JSON to the stream when pretty is off", () => {
    const sink = capture();
    const logger = createLogger({
      scope: "gateway",
      stream: sink.stream,
      pretty: false,
      now: fakeClock(),
    });
    logger.info("started", { port: 18789 });
    expect(JSON.parse(sink.text())).toEqual({
      time: "2026-01-01T00:00:00.000Z",
      level: "info",
      scope: "gateway",
      message: "started",
      fields: { port: 18789 },
    });
  });

  it("omits the fields key when there are none", () => {
    const sink = capture();
    createLogger({ scope: "s", stream: sink.stream, pretty: false }).info("plain");
    expect("fields" in (JSON.parse(sink.text()) as object)).toBe(false);
  });

  it("includes fields in the human format", () => {
    const sink = capture();
    createLogger({ scope: "s", stream: sink.stream }).warn("slow", { ms: 1200 });
    expect(sink.text()).toContain('WARN  s: slow {"ms":1200}');
  });
});

describe("file logging", () => {
  it("appends JSON Lines to the file", () => {
    const dir = tempDir();
    const file = path.join(dir, "logs", "clawagent.log");
    const logger = createLogger({ scope: "cli", file, stream: capture().stream });
    logger.info("one");
    logger.error("two", { code: 2 });
    const records = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { message: string });
    expect(records.map((record) => record.message)).toEqual(["one", "two"]);
  });

  it("creates the log directory", () => {
    const dir = tempDir();
    const file = path.join(dir, "nested", "deeper", "clawagent.log");
    createLogger({ scope: "cli", file, stream: capture().stream }).info("x");
    expect(existsSync(file)).toBe(true);
  });

  it("still writes to the stream when the file is unusable", () => {
    // Logging must never be the reason the host stops working.
    const dir = tempDir();
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const sink = capture();
    const logger = createLogger({
      scope: "cli",
      file: path.join(blocker, "logs", "clawagent.log"),
      stream: sink.stream,
    });
    expect(() => logger.info("still visible")).not.toThrow();
    expect(sink.text()).toContain("still visible");
  });
});

describe("rotateLogFile", () => {
  it("does nothing below the size limit", () => {
    const dir = tempDir();
    const file = path.join(dir, "log");
    writeFileSync(file, "small", "utf8");
    expect(rotateLogFile(file, { maxBytes: 1024, keepRotations: 2 })).toBe(false);
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  it("rotates once past the limit", () => {
    const dir = tempDir();
    const file = path.join(dir, "log");
    writeFileSync(file, "x".repeat(200), "utf8");
    expect(rotateLogFile(file, { maxBytes: 100, keepRotations: 2 })).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("shifts generations rather than overwriting them", () => {
    const dir = tempDir();
    const file = path.join(dir, "log");
    writeFileSync(file, "a".repeat(200), "utf8");
    rotateLogFile(file, { maxBytes: 100, keepRotations: 3 });
    writeFileSync(file, "b".repeat(200), "utf8");
    rotateLogFile(file, { maxBytes: 100, keepRotations: 3 });
    expect(readFileSync(`${file}.1`, "utf8")[0]).toBe("b");
    expect(readFileSync(`${file}.2`, "utf8")[0]).toBe("a");
  });

  it("bounds the number of generations", () => {
    // This is the rule that keeps a long-running Gateway from filling /data.
    const dir = tempDir();
    const file = path.join(dir, "log");
    for (let round = 0; round < 8; round += 1) {
      writeFileSync(file, `${round}`.repeat(200), "utf8");
      rotateLogFile(file, { maxBytes: 100, keepRotations: 2 });
    }
    const generations = readdirSync(dir).filter((name) => /^log\.\d+$/u.test(name));
    expect(generations.sort()).toEqual(["log.1", "log.2"]);
    // The newest generation survives.
    expect(readFileSync(`${file}.1`, "utf8")[0]).toBe("7");
  });

  it("drops the oldest generation when keepRotations shrinks", () => {
    const dir = tempDir();
    const file = path.join(dir, "log");
    writeFileSync(file, "x".repeat(200), "utf8");
    rotateLogFile(file, { maxBytes: 100, keepRotations: 3 });
    writeFileSync(file, "y".repeat(200), "utf8");
    rotateLogFile(file, { maxBytes: 100, keepRotations: 1 });
    expect(existsSync(`${file}.2`)).toBe(false);
  });

  it("returns false for a file that does not exist", () => {
    const dir = tempDir();
    expect(rotateLogFile(path.join(dir, "missing"), { maxBytes: 1 })).toBe(false);
  });

  it("rotates during normal logging", () => {
    const dir = tempDir();
    const file = path.join(dir, "clawagent.log");
    const logger = createLogger({
      scope: "cli",
      file,
      stream: capture().stream,
      maxBytes: 120,
      keepRotations: 2,
    });
    for (let index = 0; index < 20; index += 1) {
      logger.info(`message number ${index} with some padding to exceed the cap`);
    }
    const total = readdirSync(dir)
      .filter((name) => name.startsWith("clawagent.log"))
      .reduce((sum, name) => sum + readFileSync(path.join(dir, name), "utf8").length, 0);
    // Bounded by maxBytes * (keepRotations + 1), with slack for the line that
    // pushed the live file over the cap before it was rotated.
    expect(total).toBeLessThan(120 * (2 + 1) + 200);
  });

  it("has sane defaults", () => {
    expect(DEFAULT_MAX_LOG_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_KEEP_ROTATIONS).toBeGreaterThanOrEqual(1);
  });
});

describe("child loggers", () => {
  it("narrows the scope", () => {
    const sink = capture();
    const child = createLogger({ scope: "gateway", stream: sink.stream }).child("ws");
    expect(child.scope).toBe("gateway:ws");
    child.info("connected");
    expect(sink.text()).toContain("gateway:ws: connected");
  });

  it("inherits the level and the stream", () => {
    const sink = capture();
    const parent = createLogger({ scope: "gateway", level: "error", stream: sink.stream });
    const child = parent.child("ws");
    expect(child.level).toBe("error");
    child.info("suppressed");
    child.error("kept");
    expect(sink.lines()).toHaveLength(1);
  });

  it("writes to the same file as its parent", () => {
    // One transcript per run is what a phone user can actually inspect.
    const dir = tempDir();
    const file = path.join(dir, "clawagent.log");
    const parent = createLogger({ scope: "cli", file, stream: capture().stream });
    parent.child("agent").info("from the child");
    const scopes = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { scope: string }).scope);
    expect(scopes).toEqual(["cli:agent"]);
  });
});
