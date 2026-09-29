#!/usr/bin/env node
// `clawagent` — the Termux-native host entry point.
//
// This file is plain JavaScript on purpose. It is the one module that must load
// before anything else, so it cannot depend on the TypeScript loader working;
// its job is to verify that it does, arrange the flags the shared cores need,
// install source resolution, and only then hand over to the CLI.
//
// Startup order is load-bearing:
//
//   1. Confirm this Node can run TypeScript sources at all. ClawAgent ships as
//      source, and Node refuses to strip types inside `node_modules`, so a
//      checkout copied into `node_modules` cannot work. Say so plainly instead
//      of failing with a syntax error in some unrelated module.
//   2. Respawn once with `--experimental-transform-types`. A few reused core
//      files use parameter properties, which strip-only mode rejects outright.
//      Flags cannot be added to a running process, hence the re-exec.
//   3. Install the resolve hook that maps `@openclaw/*` to the checkout's
//      `packages/*/src` and rewrites `.js` specifiers to their `.ts` sources.
//   4. Import and run the CLI.
//
// Step 3 must precede step 4: the CLI pulls in the shared cores.

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Reserved for "the runtime itself is wrong", distinct from any CLI exit code. */
const EXIT_RUNTIME = 3;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKAGE_DIR = path.dirname(path.dirname(SCRIPT_PATH));

function fail(message) {
  process.stderr.write(`clawagent: ${message}\n`);
  process.exitCode = EXIT_RUNTIME;
}

// --- 1. can this Node run TypeScript sources at all? ------------------------
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
  // --- 2. respawn once with the flags the shared cores need -----------------
  const { buildNodeFlagRespawnPlan } = await import("../src/runtime/node-flags.ts");
  const plan = buildNodeFlagRespawnPlan({
    scriptPath: SCRIPT_PATH,
    userArgs: process.argv.slice(2),
  });

  if (plan) {
    const child = spawn(plan.command, plan.args, { stdio: "inherit", env: plan.env });
    child.on("error", (error) => {
      fail(`failed to re-exec node with ${plan.addedFlags.join(" ")}: ${error.message}`);
    });
    // SIGINT is not forwarded: the child shares this process group, so the
    // terminal already delivers it, and forwarding would signal twice — which
    // in an interactive session reads as "quit" when the user meant "cancel".
    // SIGTERM and SIGHUP usually come from a supervisor that signals only us.
    for (const signal of ["SIGTERM", "SIGHUP"]) {
      process.on(signal, () => {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      });
    }
    child.on("exit", (code, signal) => {
      if (code !== null) {
        process.exitCode = code;
        return;
      }
      const signo = signal ? osConstants.signals[signal] : undefined;
      process.exitCode = signo === undefined ? EXIT_RUNTIME : 128 + signo;
    });
  } else {
    // --- 3. resolve the shared cores from the checkout ---------------------
    const { findPackagesDir } = await import("../src/runtime/repo-layout.ts");
    const { installSourceResolutionHooks } = await import("../src/runtime/source-resolution.ts");
    const packagesDir = findPackagesDir(path.dirname(SCRIPT_PATH));
    // Not installing is not an error: without a checkout, `@openclaw/*` resolves
    // through node_modules like any other dependency.
    //
    // `packageDir` is passed alongside it because the cores live in
    // `packages/*/src` and import their npm dependencies by bare name, which
    // Node resolves by walking upward *from those files* — so a device that
    // installed inside `ClawAgent/` would otherwise fail to find `openai` at all.
    // See `resolveRuntimeDependency` for why NODE_PATH is not the answer.
    installSourceResolutionHooks(
      packagesDir ? { packagesDir, runtimeDependenciesDir: PACKAGE_DIR } : {},
    );

    // --- 4. run ------------------------------------------------------------
    // The real streams are passed rather than letting runCli buffer into
    // strings: an interactive chat has to render tokens as they arrive, and a
    // buffered CLI would appear to hang until the whole reply finished.
    const { runCli } = await import("../src/cli/main.ts");
    const result = await runCli({
      argv: process.argv.slice(2),
      stdout: process.stdout,
      stderr: process.stderr,
    });
    process.exitCode = result.exitCode;
  }
}
