# ClawAgent Guide

This directory owns the Termux-native mobile host: a rebuild of OpenClaw's host
layer that runs from source on an Android phone. Rules that belong only to this
folder live here; repo-global architecture, verification, and git workflow rules
stay in the root `AGENTS.md`.

The overall design, reuse map, and milestone ladder are in
[`../TERMUX-REBUILD-PLAN.md`](../TERMUX-REBUILD-PLAN.md). Read it before adding
a feature — it states which existing packages are safe to compose and which are
contaminated.

## The Rules That Surprise People

**1. Relative imports use real `.ts` extensions.**

Everywhere else in this repo, TypeScript sources import each other with `.js`
specifiers (`./thing.js` resolving to `thing.ts`). That works because a build
step emits the `.js` files. ClawAgent has no build step: it runs directly under
Node's type stripping on the device, and that loader resolves only files that
actually exist. A `.js` specifier pointing at a `.ts` source is
`ERR_MODULE_NOT_FOUND` at startup.

This is a deliberate divergence, not an oversight. Do not "fix" it.

**2. The shared cores are composed from source, and their npm dependencies are declared here.**

At M0 this rule read "zero runtime dependencies", because `packages/*` all use
`.js` specifiers internally (`ai` has 653) and none of them could be imported
from source on a device. M1 removed that obstacle instead of working around it:
`src/runtime/source-resolution.ts` installs a `module.registerHooks` resolve hook
that maps `@openclaw/*` onto package sources and rewrites a relative `.js`
specifier to the `.ts` file that exists, and `bin/clawagent.mjs` re-executes with
`--experimental-transform-types` because two reused cores (`ai`, `retry`) use
parameter properties that strip-only mode rejects.

Three consequences, each of which has broken once already:

- **ClawAgent declares what the cores need, and never asks npm for the cores.**
  Because the cores are read from the checkout rather than installed, *their*
  `dependencies` never reach an install rooted here. `package.json` therefore
  lists the cores' external npm packages at exactly the versions the cores pin,
  and records the cores themselves in the `clawagent` block (`reusedPackages`)
  instead of in `dependencies`. That is not cosmetics: the only range that could
  express "use this checkout" is `workspace:*`, which is a pnpm protocol, and
  naming it in `dependencies` makes the `npm install --omit=dev` the README gives
  a phone user fail with `EUNSUPPORTEDPROTOCOL` before it downloads anything. Do
  not hand-edit either list: `src/runtime/reused-packages.ts` recomputes them from
  the cores' manifests, and both `test/boundary.test.ts` and the smoke script fail
  on drift, including on any non-registry range. A missing entry surfaces as
  `ERR_MODULE_NOT_FOUND` inside a provider transport, which reads like a broken
  install rather than a stale manifest.
- **Only declared public entry points.** The resolver reads each package's
  `exports` map. A deep import such as `@openclaw/ai/src/env-api-keys` would
  resolve through the layout fallback today and break the moment that package
  moves a file. `@openclaw/ai` keeps its env-key helpers off the public surface
  on purpose, so ClawAgent's provider presets own the conventional variable names
  instead.
- **The `exports` map is authoritative and dist paths are not flat.**
  `@openclaw/llm-core/event-stream` declares `./dist/utils/event-stream.mjs`, so
  its source is `src/utils/event-stream.ts`. An earlier resolver guessed
  `src/<subpath>.ts`, mapped it to nothing, and made `@openclaw/ai/providers` —
  and therefore all of chat — unloadable. Do not simplify it back.

**3. Nothing that only `npm install` can provide is imported at CLI startup.**

`clawagent doctor`, `version`, and `help` must work on a clone that has installed
nothing, because doctor is the command that tells you what to install. A single
static `import { Type } from "typebox"` anywhere reachable from `src/cli/main.ts`
turns all three into `ERR_MODULE_NOT_FOUND`, which is the opposite of a diagnosis.
So the heavy things are imported where they are used, inside the async function
that needs one: `createAgentSession` awaits `@openclaw/agent-core`,
`@openclaw/tool-call-repair`, and the tool layer together, and `runAgent` does the
same for the plan `--dry-run` prints. `test/boundary.test.ts` walks the static
import closure of the CLI and fails on a bare specifier that is not `@openclaw/*`
(those resolve from the checkout with no install at all).

The same reasoning applies to the phone in general: startup cost on a mid-range
device is not free, and a flag that only prints help should not parse a markdown
parser to do it.

**The one remaining deliberate duplication** is `src/platform/termux.ts`, and the
reason is structural rather than historical: platform detection runs in the entry
point *before* the resolve hook exists, so it cannot import a workspace package
even in principle. `termux-contract.test.ts` pins the copy against
`@openclaw/normalization-core` and fails if they diverge.

`src/config/paths.ts` used to duplicate the home-dir and agent-id rules for the
same reason and no longer does: it re-exports the upstream bindings, and
`paths-contract.test.ts` asserts *identity*, so a local lookalike with matching
behaviour still fails the suite. Prefer re-exporting over wrapping — a wrapper
function quietly reintroduces the drift the re-export forecloses.

## Import Boundaries

`test/boundary.test.ts` enforces these, and `scripts/smoke-termux.sh` re-checks
them with plain `grep` so they still hold on a device where vitest cannot run.

- Never import the root `openclaw` package.
- Never import `extensions/*`, `plugin-sdk`, or `memory-host-sdk`. These escape
  into `src/` and carry roughly ten thousand internal imports; they are the
  contamination this rebuild exists to avoid.
- Never import `../../src/*` (the desktop host).
- Never add a native addon, and never import `node-pty`. Termux cannot load
  glibc-linked prebuilds. Terminal tools go through `child_process`.
- Never hardcode `/bin`, `/usr/bin`, `/etc`, or `/var`. Termux has none of them.
  Resolve through `$PREFIX` and `$PATH`.
- Import shared cores only through entry points their `package.json` `exports`
  declares, and add the package to `src/runtime/reused-packages.ts` in the same
  commit. The reuse list is a decision, not an accident of what resolved.
- Any external npm dependency a reused core needs must be declared in
  `package.json` at the version the core pins. The boundary test recomputes the
  set; a hand-edited list will not match it.
- The single permitted import above this directory is `../../../node-version.mjs`.
  It is an explicitly shared, zero-dependency contract that owns the Node floor
  for a correctness reason (older Node lines read SQLite `TEXT` lossily). Do not
  re-declare that floor locally, and do not add a second upward import without
  updating both the boundary test and its allowlist.

## What The Cores' `exports` Maps Actually Look Like

`src/runtime/source-resolution.ts` maps a bare `@openclaw/<pkg>/<sub>` onto
`packages/<pkg>/src/...`, and it has to be forgiving because three real shapes
occur — and because a declared entry is not always a truthful one.

1. Flat, the common case: `./dist/utils/event-stream.mjs` -> `src/utils/event-stream.ts`.
2. Flattened directory: `./dist/harness/compaction.js` -> `src/harness/compaction/compaction.ts`.
   A build can collapse a source directory into one file, so a bare
   `src/<stem>.ts` guess finds nothing.
3. Moved module, found by unique basename: `@openclaw/ai`'s `./diagnostics`
   declares `./dist/diagnostics.mjs`, but the module is `src/utils/diagnostics.ts`
   and `ai` has no build script, so the declared path can never exist. The
   basename is unique inside `src`, which is enough; the rule refuses to resolve
   an ambiguous name rather than guess. Redirecting that specifier to
   `@openclaw/llm-core/diagnostics` instead is *wrong* — `ai`'s file is a shim
   that re-exports llm-core **plus** its own symbols, and `isResponsesOutputLimitToolCallError`,
   which `agent-core` needs, is one of them.

One declared subpath is knowingly left unresolvable: `@openclaw/agent-core/harness/branch-summarization`.
Its file is `src/harness/compaction/branch-summarization.ts` and no
`src/harness/branch-summarization.ts` exists, so no path rule can recover it. It
is reachable from the checkout through `@openclaw/agent-core` (which re-exports it
by relative path), so import it from the root entry point and do not add a
hardcoded exception for it.

`@openclaw/ai` also imports `../../../markdown-core/src/reasoning-tags.js` — a
*relative* path into a neighbouring package, which no exports map and no
dependency declaration records. `packages/ai/package.json` therefore does not list
`@openclaw/markdown-core`, yet anything loading `@openclaw/ai/transports`
(`agent-core` does) executes markdown-core and needs `markdown-it`,
`markdown-it-cjk-friendly`, `mdast-util-from-markdown`, `mdast-util-gfm-table`,
`micromark-extension-gfm-table`, and `yaml` present. That is the recurring trap
this directory keeps hitting: **what a package declares is not what it loads.**
When a milestone adds a core, walk the real module graph — `reused-packages.ts`
and `package.json` are then checked against it by `test/boundary.test.ts`.

`test/vitest/vitest.shared.config.ts` mirrors these mappings for the repo test
runner. It is shared infrastructure outside this directory, and its alias list is
first-match-wins with subpaths before the bare package name, so new entries go in
ahead of `sourcePackageAliasesFromExports`.

## Tools and Approvals (M2)

The agent loop is `Agent` from `@openclaw/agent-core`. Everything ClawAgent owns
sits in three folders, and each has one rule that is not obvious from the code.

**`src/tools/` — containment lives in `workspace.ts`, once.** `resolveToolPath`
checks lexically, then walks every ancestor to catch a symlink pointing out, then
canonicalises and re-checks, then insists the parent is a directory. The order is
the point: an earlier version canonicalised first and reported
`secret.txt/secret.txt` for a file symlink, which is a message about the
filesystem rather than about the mistake. `strict` is the only policy a CLI user
can get; `open` exists for tests and for a future caller that has its own
boundary. Every tool returns text a model can act on, including the refusal:
"Re-read it and copy the exact text, including indentation" beats `EINVAL`.

**`glob` skips `node_modules`, `dist`, `.git`, and friends, and says when it ran
out.** A truncated result that looks complete is worse than a small one: the model
stops looking.

**`bash` never goes through a shell.** No `/bin/sh -c`, so no `;`, no pipe, no
`$(...)`; `splitCommandLine` in `src/util/command-argv.ts` turns the string into
argv and *refuses* shell operators with a hint about what to do instead. The
program is found on `PATH` (`Termux`'s `$PREFIX/bin` is on it, `/bin` is not a
thing to assume), the process group is killed on timeout or abort, both streams are
capped separately, and a non-zero exit is a *result* rather than a thrown error —
`grep` with no matches is not a failure. `node-pty` and PTYs are off-limits by
policy; the dependency audit in `test/boundary.test.ts` will fail them.

**`read-only` removes tools; it does not refuse them.** `toolOptionsForMode` in
`src/agent/runner.ts` is the single place that decides, and both the live session
and the `--dry-run` plan go through it, so the flag cannot advertise a tool the
run does not have. `bash` counts as mutating: a shell that can run anything can
write anything.

**Approvals rules are checked in deny-before-allow order, always.**
`src/approvals/policy.ts` is pure and total: destructive-command and
sensitive-path checks come *before* the `mode === "full"` short-circuit, so
`--yes` cannot reach `rm -rf /` or `~/.ssh/id_*`. An unknown mode is a usage error
listing the modes, never a silent fallback — a default that guesses looser is the
failure mode that ends in deleted files. `--yes` and `--approve` together is
refused rather than resolved, because flag order should not decide who may write.

**The prompt does not use `@openclaw/terminal-core`, deliberately.** Its styled
select wraps `@clack/prompts`, which needs a raw-mode TTY and reports
`terminal=false` when stdin is redirected — exactly the piped, scripted conditions
every gate here runs under, on a device where a hung prompt is indistinguishable
from a slow model. So approvals share the queue-based readline prompter that
`chat` already uses (`src/approvals/gate.ts`), EOF means "no", and three bad
answers means "no". If a later milestone wants the styled UI, it has to make it
work with no TTY first.

**The turn cap terminates, it does not abort.** `afterToolCall` returns
`{ terminate: true }` when the limit is hit, which leaves `stoppedReason` set and
`ok` true. `agent.abort()` would report a capped run like a failed one, and the
user would read a working session as a crash.

**The M2 proof is `src/agent/runner.test.ts`.** It runs the real loop against real
files with a faked provider transport: write `sum.js`, read it back, fix the bug,
with approvals answered from a script. If you change the tool layer, the approvals
policy, or the loop wiring, that file is where the combination is still checked.

## Termux Realities That Shape Code

These are not hypothetical; each one has produced a bug on a phone.

- **`os.homedir()` can be wrong.** With `HOME` unset — common under
  `termux-services`, `cron`, and Termux:Boot — Node returns `$PREFIX/home`,
  which does not exist. The real home is `$PREFIX/..`. `src/config/paths.ts`
  handles this; go through it rather than calling `os.homedir()` directly.
- **There is no `/etc/passwd`**, so nothing can be looked up from it.
- **`os.totalmem()` is device RAM, not a budget.** Android's low-memory killer
  ends the process long before V8 reaches a heap sized from that number. The
  desktop host derives `--max-old-space-size=4096` from it
  (`src/daemon/gateway-heap.ts`); do not port that reasoning here.
- **`os.availableParallelism()` overstates throughput.** It counts big.LITTLE
  cores as equals. The desktop host derives 32 concurrent agent runs from an
  octa-core phone (`src/config/agent-limits.ts`) and 8 worker isolates
  (`src/infra/worker-task-pool-core.ts`). Neither survives contact with a phone
  that is also running the OS and a browser.
- **There is no swap.** Memory pressure is fatal, not slow.
- **Doze suspends the process when the screen turns off** unless a partial wake
  lock is held via `termux-wake-lock`. This is what makes an always-on assistant
  possible at all.
- **`termux-api` is two installs**: the `pkg install termux-api` package *and*
  the Termux:API Android app from F-Droid. The Play Store build is stale and
  will not talk to the package. Absence is a normal, reportable state.
- **Never suggest `nvm`, `n`, `fnm`, or `install.sh` on Android.** They fetch
  glibc tarballs and the Android kernel refuses to execute glibc ELF. The only
  supported path is `pkg install nodejs-lts`.

## Capability Ledger

`src/capability/ledger.ts` is the single place the host records what it can do
on this device. Every milestone registers its capabilities here instead of
inventing its own detection.

- Use `degraded` when the host still works with a smaller promise. Reporting
  `unavailable` tells the user to fix something that is fine; reporting
  `available` hides a real limitation.
- Mark a capability `required` only when the host cannot start without it.
  Required + not-available is what sets `startable` and the exit code.
- **A caveat is not a remediation.** `remediation` is for actions the user can
  take (`pkg install termux-api`). Facts about the device that explain a number
  belong in the report body — see how `resources.memory` caveats render as a
  footnote in `src/cli/doctor.ts`.
- State the fix once. Per-command `termux-api` rows deliberately carry no
  remediation because they all share one install step; repeating it five times
  buries the thing the user needs to type.
- Remediation text is host-specific. Termux says `pkg install ...`; a desktop
  says what a normal machine needs. Never merge the two, because only one of
  them can work on Android.

## Errors and Degrade Paths

Platform code returns typed results instead of throwing. A missing command, a
full disk, a revoked permission, or a closed stream is a normal condition on a
phone, and an exception escaping into the agent loop costs far more there than
on a server. See `runTermuxCommand` and `probeWritableDirectory` for the shape.

Logging must never be the thing that crashes the host, and log files must stay
bounded: `src/logging/logger.ts` rotates on size and keeps a fixed number of
generations, because an unbounded log fills `/data` and takes Android with it.

Exit codes are a contract rather than an implementation detail.
`src/cli/exit-codes.ts` is the single list — command modules import it, because
importing `main.ts` for a constant would be a cycle — and the smoke script
asserts the values:

| code | meaning |
| ---- | ------- |
| `0` | success |
| `1` | this device cannot run the host (`doctor`) |
| `2` | usage: unknown command, bad or missing flag value |
| `3` | config or credentials unusable, so the command never started |
| `4` | startup succeeded and the model turn failed |

A failed turn *inside* an interactive chat does not end the session: the loop
reports the error, rolls the turn back out of history, and keeps reading. Losing a
conversation to one dropped mobile connection is worse than any exit code, and a
dangling user message the model never saw would corrupt the next request.

Provider failures are classified in `src/provider/errors.ts` into network, auth,
rate-limit, model, and aborted, because a vendor SDK reports a dead mobile
connection as the two words "Connection error." and sends the user to check
everything except the thing that is wrong. Classification is additive: the
provider's own text is always printed, so a wrong guess cannot make a diagnosis
worse than no guess.

## Running And Testing

```sh
node bin/clawagent.mjs doctor            # capability report for this device
node bin/clawagent.mjs doctor --json     # machine-readable
bash scripts/smoke-termux.sh             # full smoke test, no dev toolchain needed
bash scripts/smoke-termux.sh --quiet     # summary and failures only
```

From the repo root, once workspace dependencies are installed:

```sh
pnpm --filter clawagent test
```

Two suites, two different jobs:

- **vitest** (`**/*.test.ts`) is the thorough one and needs the dev toolchain, so
  it runs in CI. It includes the contract tests that pin ClawAgent's agreements
  with the shared packages — by identity for the rules it re-exports, and case by
  case for the one copy it must keep (`platform/termux.ts`).
- **`scripts/smoke-termux.sh`** runs on a phone with the runtime dependencies
  installed (`npm install --omit=dev`) and no dev toolchain. It reports missing
  dependencies once, up front, instead of failing every later check with a
  module-not-found error that blames the wrong thing.
  It cannot import vitest, so it re-checks the boundaries with `grep` and
  exercises the CLI end to end. Every milestone ships a smoke check; add to this
  script rather than writing a second one.

The smoke script is `set -uo pipefail` **without** `-e`, on purpose: a smoke test
that stops at the first failure reports one problem when it could report five,
and a second run on a device may not be cheap. Note that `pipefail` plus a
`head`/`grep -q` pipeline reports the writer's `SIGPIPE` rather than the answer
you asked for — capture output into a variable first, or the check will pass for
the wrong reason.

## Scope

- Keep mobile-host-specific rules here.
- Leave repo-global architecture, verification, and git workflow rules in the
  root `AGENTS.md`.
- `packages/*` are read-only from this folder's perspective. If a shared core
  needs a change, make it in the package with its own tests, not by forking it
  in here.
