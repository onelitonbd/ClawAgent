// Logging for the mobile host.
//
// Zero-dependency, and written around two phone realities:
//
//   1. Storage is small and shared with the OS. An unbounded log fills `/data`
//      and takes Android down with it, so every log file rotates on size and
//      only a fixed number of generations are kept.
//
//   2. Logging must never be the thing that crashes the host. A full disk, a
//      revoked permission, or a closed stream is a normal condition here, so
//      every write is guarded and failures degrade to "this log line was lost"
//      rather than an exception escaping into the agent loop.
//
// File output is JSON Lines: the same transcript is read by `doctor`, by the
// gateway, and later by the Control UI log view, and none of them should have
// to parse a human format.

import { appendFileSync, mkdirSync, renameSync, statSync, rmSync } from "node:fs";
import path from "node:path";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Default cap for one log generation. Small on purpose: this is a phone. */
export const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024;
/** Default number of rotated generations kept alongside the live file. */
export const DEFAULT_KEEP_ROTATIONS = 2;

/**
 * Minimal write target.
 *
 * Deliberately looser than `NodeJS.WritableStream`: the CLI passes its own
 * capture buffer, and requiring the full stream interface would force every
 * caller to fake `end`, `destroy`, and the boolean return.
 */
export type LogStream = { write(chunk: string): unknown };

export type LogRecord = {
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  fields?: Record<string, unknown>;
};

export type LoggerOptions = {
  /** Scope name; also the log file name. */
  scope: string;
  /** Absolute log file path. Omit to log only to the console stream. */
  file?: string;
  level?: LogLevel;
  /** Defaults to `process.stderr` so stdout stays machine-readable. */
  stream?: LogStream;
  /** Write human lines to the stream instead of JSON. Default true. */
  pretty?: boolean;
  maxBytes?: number;
  keepRotations?: number;
  /** Injectable clock, for tests. */
  now?: () => Date;
};

export type Logger = {
  readonly scope: string;
  readonly level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** True when a level would be emitted, so callers can skip building fields. */
  enabled(level: LogLevel): boolean;
  /**
   * Derives a logger with a narrower scope that shares this logger's file and
   * level, so a subsystem's lines stay in the same transcript.
   */
  child(scope: string): Logger;
  /** Closes the logger; currently a no-op kept for interface stability. */
  close(): void;
};

/** Parses a level name, defaulting to `info` for anything unrecognised. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return LOG_LEVELS.find((level) => level === normalized) ?? "info";
}

function formatHuman(record: LogRecord): string {
  const fields =
    record.fields && Object.keys(record.fields).length > 0
      ? ` ${JSON.stringify(record.fields)}`
      : "";
  return `${record.time} ${record.level.toUpperCase().padEnd(5)} ${record.scope}: ${record.message}${fields}\n`;
}

/**
 * Rotates `file` when it has grown past `maxBytes`.
 *
 * Generations are shifted `log.2 -> log.3`, `log.1 -> log.2`, `log -> log.1`
 * and the oldest is dropped, so total log footprint is bounded by
 * `maxBytes * (keepRotations + 1)` no matter how long the Gateway runs.
 */
export function rotateLogFile(
  file: string,
  options: { maxBytes?: number; keepRotations?: number } = {},
): boolean {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  const keep = Math.max(0, options.keepRotations ?? DEFAULT_KEEP_ROTATIONS);
  try {
    const size = statSync(file).size;
    if (size < maxBytes) {
      return false;
    }
    const oldest = `${file}.${keep}`;
    rmSync(oldest, { force: true });
    for (let generation = keep - 1; generation >= 1; generation -= 1) {
      const from = `${file}.${generation}`;
      try {
        statSync(from);
      } catch {
        continue;
      }
      renameSync(from, `${file}.${generation + 1}`);
    }
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    // A missing file is the normal first-run case; anything else is not worth
    // escalating from inside the logger.
    return false;
  }
}

/** Creates a logger. Never throws, including when the log file is unusable. */
export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? "info";
  const stream = options.stream ?? process.stderr;
  const pretty = options.pretty ?? true;
  const now = options.now ?? (() => new Date());
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  const keepRotations = options.keepRotations ?? DEFAULT_KEEP_ROTATIONS;
  const file = options.file;
  // A directory is created once, up front. If it fails, file logging is simply
  // disabled for the lifetime of this logger rather than retried per line,
  // because retrying a permission error on every log call is a performance and
  // noise problem on a device.
  let fileLoggingEnabled = Boolean(file);
  if (file) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      fileLoggingEnabled = false;
    }
  }

  function emit(recordLevel: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[recordLevel] < LEVEL_RANK[level]) {
      return;
    }
    const record: LogRecord = {
      time: now().toISOString(),
      level: recordLevel,
      scope: options.scope,
      message,
      ...(fields ? { fields } : {}),
    };
    if (fileLoggingEnabled && file) {
      try {
        rotateLogFile(file, { maxBytes, keepRotations });
        appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
      } catch {
        fileLoggingEnabled = false;
      }
    }
    try {
      stream.write(pretty ? formatHuman(record) : `${JSON.stringify(record)}\n`);
    } catch {
      // The stream can be closed when the process is already tearing down.
    }
  }

  return {
    scope: options.scope,
    level,
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    enabled: (candidate) => LEVEL_RANK[candidate] >= LEVEL_RANK[level],
    child: (childScope) =>
      createLogger({
        scope: `${options.scope}:${childScope}`,
        level,
        stream,
        pretty,
        maxBytes,
        keepRotations,
        now,
        ...(file ? { file } : {}),
      }),
    close: () => {},
  };
}
