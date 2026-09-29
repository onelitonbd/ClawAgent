// Public surface of the ClawAgent mobile host.
//
// Everything re-exported here is zero-runtime-dependency and safe to import from
// a Termux checkout with no build step. Specifiers use the real `.ts` extension
// on purpose: see `tsconfig.json` and `AGENTS.md` for why this package diverges
// from the repository's `.js`-specifier convention.
//
// Test files are deliberately excluded from this barrel.

export * from "./capability/ledger.ts";
export * from "./cli/argv.ts";
export * from "./cli/doctor.ts";
export * from "./cli/main.ts";
export * from "./config/paths.ts";
export * from "./logging/logger.ts";
export * from "./platform/facts.ts";
export * from "./platform/node-requirement.ts";
export * from "./platform/termux-api.ts";
export * from "./platform/termux.ts";
export * from "./version.ts";
