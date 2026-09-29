# ClawAgent Guide

This directory owns the Termux-native mobile host: a rebuild of OpenClaw's host
layer that runs from source on an Android phone. Rules that belong only to this
folder live here; repo-global architecture, verification, and git workflow rules
stay in the root `AGENTS.md`.

The overall design, reuse map, and milestone ladder are in
[`../TERMUX-REBUILD-PLAN.md`](../TERMUX-REBUILD-PLAN.md). Read it before adding
a feature — it states which existing packages are safe to compose and which are
contaminated.

## The Two Rules That Surprise People

**1. Relative imports use real `.ts` extensions.**

Everywhere else in this repo, TypeScript sources import each other with `.js`
specifiers (`./thing.js` resolving to `thing.ts`). That works because a build
step emits the `.js` files. ClawAgent has no build step: it runs directly under
Node's type stripping on the device, and that loader resolves only files that
actually exist. A `.js` specifier pointing at a `.ts` source is
`ERR_MODULE_NOT_FOUND` at startup.

This is a deliberate divergence, not an oversight. Do not "fix" it.

**2. There are zero runtime dependencies, including workspace packages.**

`packages/*` all use `.js` specifiers internally (`agent-core` has 103, `ai` has
653, `gateway-protocol` has 603), so none of them can be imported from source on
a device. Node also refuses to strip types inside `node_modules`, so a shim
cannot route around it. Until a build or bundle step exists, `dependencies` must
stay empty and `optionalDependencies` must not exist.

`devDependencies` may reference pure-TypeScript workspace packages, because
those are only ever resolved by the test runner in CI.

The cost of rule 2 is real duplication: `src/config/paths.ts` reimplements the
home-dir rules from `@openclaw/normalization-core/home-dir`, and
`src/platform/termux.ts` reimplements part of the same contract. Both are pinned
by contract tests (`paths-contract.test.ts`, `termux-contract.test.ts`) that
import the real package and assert agreement case by case. **If you change one
side, change the other in the same commit** — the contract test will fail until
you do. When a build step lands, delete the local copies rather than keeping
both.

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
- The single permitted import above this directory is `../../../node-version.mjs`.
  It is an explicitly shared, zero-dependency contract that owns the Node floor
  for a correctness reason (older Node lines read SQLite `TEXT` lossily). Do not
  re-declare that floor locally, and do not add a second upward import without
  updating both the boundary test and its allowlist.

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

## Running And Testing

```sh
node bin/clawagent.mjs doctor            # capability report for this device
node bin/clawagent.mjs doctor --json     # machine-readable
bash scripts/smoke-termux.sh             # full smoke test, no node_modules needed
bash scripts/smoke-termux.sh --quiet     # summary and failures only
```

From the repo root, once workspace dependencies are installed:

```sh
pnpm --filter clawagent test
```

Two suites, two different jobs:

- **vitest** (`**/*.test.ts`) is the thorough one and needs `node_modules`, so it
  runs in CI. It includes the contract tests that pin the local duplications
  against the real packages.
- **`scripts/smoke-termux.sh`** runs on a phone with nothing installed but Node.
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
