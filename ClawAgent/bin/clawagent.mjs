#!/usr/bin/env node
// `clawagent` — the Termux-native host entry point.
//
// This file is plain JavaScript on purpose. It is the one module that must load
// before anything else, so it cannot depend on the TypeScript loader working;
// its first job is to verify that it does.
//
// ClawAgent ships as source and runs under Node's built-in type stripping. That
// has one hard constraint worth checking up front rather than failing obscurely:
// Node refuses to strip types for files inside `node_modules`. Running from a
// clone, or through a `npm link` symlink (Node resolves the real path, which is
// outside `node_modules`), works. Copying the tree into `node_modules` does not,
// and the failure would otherwise look like a syntax error in a random module.

/** Reserved for "the runtime itself is wrong", distinct from any CLI exit code. */
const EXIT_RUNTIME = 3;

function fail(message) {
  process.stderr.write(`clawagent: ${message}\n`);
  process.exitCode = EXIT_RUNTIME;
}

const typeStripping = process.features?.typescript;
if (!typeStripping) {
  fail(
    [
      `this Node build cannot run TypeScript sources (process.features.typescript is ${JSON.stringify(typeStripping)}).`,
      "",
      "ClawAgent runs directly from source using Node's built-in type stripping,",
      "which requires a supported Node and a checkout that is not inside node_modules.",
      "",
      `  detected: node ${process.version} on ${process.platform}/${process.arch}`,
      "",
      "On Termux:",
      "  pkg update && pkg upgrade -y",
      "  pkg install nodejs-lts",
      "  node -v",
      "",
      "Then run this file from the repository checkout:",
      "  node /path/to/ClawAgent/bin/clawagent.mjs doctor",
    ].join("\n"),
  );
} else {
  const { runCli } = await import("../src/cli/main.ts");
  const result = runCli({ argv: process.argv.slice(2) });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}
