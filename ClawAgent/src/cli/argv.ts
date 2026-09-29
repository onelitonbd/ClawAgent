// Command-line parsing for `clawagent`.
//
// Zero-dependency and declarative: commands and flags are described as data, and
// parsing, validation, usage text, and error messages are all derived from that
// description. Adding the M1 `agent` command must not require touching the
// parser.
//
// Errors are returned, not thrown. A CLI that throws on a typo prints a stack
// trace to a phone user who typed `clawagent doctr`; it should print the nearest
// valid command instead. Suggestion and edit-distance helpers live in
// `../util/text-suggest.ts` so `provider/` can reuse them without depending on
// the CLI.

import { suggestName } from "../util/text-suggest.ts";

export type FlagType = "boolean" | "string";

export type FlagSpec = {
  /** Canonical long name without dashes, e.g. `json`. */
  name: string;
  /** Single-character short form without dash, e.g. `j`. */
  alias?: string;
  type: FlagType;
  description: string;
  /** Value shown in usage, e.g. `<path>`. Implied for string flags. */
  value?: string;
  default?: string | boolean;
};

export type CommandSpec = {
  name: string;
  description: string;
  flags?: FlagSpec[];
  /** Positional operand names, for usage text and arity hints. */
  args?: string[];
};

export type ParseResult = {
  /** Resolved command name, absent when none was given. */
  command?: string;
  /** Operands after the command, in order. */
  positionals: string[];
  /** Flag values keyed by canonical long name. */
  flags: Record<string, string | boolean>;
  /** True when `--help` or a bare invocation asked for usage. */
  help: boolean;
  /** True when `--version` was given. */
  version: boolean;
  /** Human-readable problems, empty on success. */
  errors: string[];
};

/** Flags understood before any command name. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "help", alias: "h", type: "boolean", description: "Show usage and exit" },
  { name: "version", alias: "V", type: "boolean", description: "Print the version and exit" },
  { name: "json", type: "boolean", description: "Emit machine-readable JSON" },
  { name: "log-level", type: "string", value: "<level>", description: "debug | info | warn | error" },
  { name: "home", type: "string", value: "<dir>", description: "Override the state directory" },
];

function findFlag(
  specs: readonly FlagSpec[],
  name: string,
): FlagSpec | undefined {
  return specs.find((spec) => spec.name === name || spec.alias === name);
}

function applyDefault(flags: Record<string, string | boolean>, specs: readonly FlagSpec[]): void {
  for (const spec of specs) {
    if (flags[spec.name] === undefined && spec.default !== undefined) {
      flags[spec.name] = spec.default;
    }
  }
}

/** Suggests the closest known command for a typo. */
export function suggestCommand(input: string, commands: readonly CommandSpec[]): string | undefined {
  return suggestName(input, commands.map((command) => command.name));
}

/** Parses `argv` (already stripped of node and the script path). */
export function parseArgv(
  argv: readonly string[],
  commands: readonly CommandSpec[],
): ParseResult {
  const errors: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | undefined;
  let help = false;
  let version = false;
  let onlyPositionals = false;

  applyDefault(flags, GLOBAL_FLAGS);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (onlyPositionals) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }
    if (token.startsWith("--") || (token.startsWith("-") && token.length > 1 && token !== "-")) {
      const raw = token.replace(/^-+/u, "");
      const eq = raw.indexOf("=");
      const name = eq === -1 ? raw : raw.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);
      const negated = name.startsWith("no-");
      const specs = command
        ? [...GLOBAL_FLAGS, ...(commands.find((entry) => entry.name === command)?.flags ?? [])]
        : GLOBAL_FLAGS;
      const spec =
        findFlag(specs, name) ?? (negated ? findFlag(specs, name.slice(3)) : undefined);
      if (!spec) {
        errors.push(`unknown flag: --${name}`);
        continue;
      }
      if (negated && spec.type === "boolean" && !findFlag(specs, name)) {
        flags[spec.name] = false;
        continue;
      }
      if (spec.type === "boolean") {
        if (inlineValue !== undefined) {
          const normalized = inlineValue.toLowerCase();
          if (normalized === "true" || normalized === "1") {
            flags[spec.name] = true;
          } else if (normalized === "false" || normalized === "0") {
            flags[spec.name] = false;
          } else {
            errors.push(`flag --${spec.name} expects true or false, got "${inlineValue}"`);
          }
          continue;
        }
        flags[spec.name] = true;
        continue;
      }
      // String flag: take the inline value, or the next token.
      if (inlineValue !== undefined) {
        flags[spec.name] = inlineValue;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) {
        errors.push(`flag --${spec.name} requires a value`);
        continue;
      }
      flags[spec.name] = next;
      index += 1;
      continue;
    }

    // Bare token: the first one selects the command.
    if (command === undefined) {
      const match = commands.find((entry) => entry.name === token.toLowerCase());
      if (match) {
        command = match.name;
        applyDefault(flags, match.flags ?? []);
        continue;
      }
      const suggestion = suggestCommand(token, commands);
      errors.push(
        suggestion
          ? `unknown command: ${token} (did you mean "${suggestion}"?)`
          : `unknown command: ${token}`,
      );
      command = token.toLowerCase();
      continue;
    }
    positionals.push(token);
  }

  if (flags.help === true) {
    help = true;
  }
  if (flags.version === true) {
    version = true;
  }

  return {
    ...(command === undefined ? {} : { command }),
    positionals,
    flags,
    help,
    version,
    errors,
  };
}

/** Renders usage for one command, or the top-level help when none is given. */
export function renderUsage(
  commands: readonly CommandSpec[],
  commandName?: string,
  program = "clawagent",
): string[] {
  if (!commandName) {
    const lines = [`Usage: ${program} <command> [flags]`, "", "Commands:"];
    const width = Math.max(...commands.map((entry) => entry.name.length), 0);
    for (const entry of commands) {
      lines.push(`  ${entry.name.padEnd(width)}  ${entry.description}`);
    }
    lines.push("", "Global flags:");
    for (const flag of GLOBAL_FLAGS) {
      lines.push(`  ${formatFlag(flag)}`.padEnd(30) + flag.description);
    }
    lines.push("", `Run "${program} <command> --help" for command-specific flags.`);
    return lines;
  }
  const spec = commands.find((entry) => entry.name === commandName);
  if (!spec) {
    return [`Unknown command: ${commandName}`, "", ...renderUsage(commands, undefined, program)];
  }
  const args = spec.args?.length ? ` ${spec.args.map((name) => `<${name}>`).join(" ")}` : "";
  const lines = [`Usage: ${program} ${spec.name}${args} [flags]`, "", spec.description];
  const own = spec.flags ?? [];
  if (own.length > 0) {
    lines.push("", "Flags:");
    for (const flag of own) {
      lines.push(`  ${formatFlag(flag)}`.padEnd(30) + flag.description);
    }
  }
  lines.push("", "Global flags also apply:");
  for (const flag of GLOBAL_FLAGS) {
    lines.push(`  ${formatFlag(flag)}`.padEnd(30) + flag.description);
  }
  return lines;
}

function formatFlag(flag: FlagSpec): string {
  const long = `--${flag.name}${flag.type === "string" ? ` ${flag.value ?? "<value>"}` : ""}`;
  return flag.alias ? `-${flag.alias}, ${long}` : `    ${long}`;
}
