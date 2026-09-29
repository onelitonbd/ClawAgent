# ClawAgent

A Termux-native host for OpenClaw, built to run on an Android phone.

OpenClaw's host layer assumes a server: `node-pty`, glibc-linked binaries,
`/etc/passwd`, swap, a stable process lifetime, and eight cores that all perform
alike. None of those hold on Android. ClawAgent rebuilds the host around what a
phone actually provides, while composing the same shared `@openclaw/*` cores, so
the agent behaves like OpenClaw rather than like a different product.

It runs **directly from source** — no build step, no bundler, no `node_modules`
on the device.

## Status

**M0 — skeleton.** Platform detection, the capability ledger, and `doctor`.

Working today:

- Detects Termux and Android, including the cases where `HOME` is unset and
  `os.homedir()` lies.
- `clawagent doctor` reports what this specific device can and cannot do, with
  the exact `pkg` command to fix each gap.
- Resolves and creates the state directory (`~/.clawagent` by default).
- Bounded, rotating JSON Lines logs.
- A smoke test that runs on a phone with nothing installed but Node.

Not built yet: the agent loop, provider chat, tools, sessions, the Gateway,
channels, and skills. The milestone ladder (M0–M13) and the reasoning behind it
are in [`../TERMUX-REBUILD-PLAN.md`](../TERMUX-REBUILD-PLAN.md).

## Requirements

- Android with [Termux](https://f-droid.org/packages/com.termux/) installed from
  **F-Droid or GitHub releases**. The Play Store build is stale and unmaintained.
- Node.js from Termux's own repository: `pkg install nodejs-lts`.
- Optional, for Android integrations: `pkg install termux-api` **and** the
  Termux:API app from F-Droid.

Do not use `nvm`, `n`, `fnm`, or a Node tarball from nodejs.org. Node.js
publishes no Android binaries, and a Linux tarball is glibc-linked — the Android
kernel refuses to execute it. Termux's `pkg` is the only supported path.

## Install and run

```sh
pkg update && pkg upgrade -y
pkg install nodejs-lts git
git clone <this repository>
cd ClawAgent/ClawAgent

node bin/clawagent.mjs doctor
```

`doctor` exits `0` when this device can run the host, `1` when it cannot, and
`2` on a usage error. Add `--json` for machine-readable output.

To put `clawagent` on your `PATH`:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/bin/clawagent.mjs" "$HOME/.local/bin/clawagent"
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.bashrc to keep it
```

Run it from a clone or through a symlink. Copying the tree into `node_modules`
will not work: Node refuses to strip types there, and the entry point says so
explicitly rather than failing with a confusing syntax error.

## Reading `doctor`

```
ClawAgent doctor
node v26.1.0 on linux/arm64 (kernel 5.15.0)
host: Termux (signal=android-platform)

home          /data/data/com.termux/files/home/.clawagent
state         /data/data/com.termux/files/home/.clawagent/state
...

ok/warn/fail, * = required to start
ok  * Node runtime     v26.1.0 (requires >=24.16.0 <25, or >=26.1.0)
ok  * node:sqlite      DatabaseSync present
ok    Termux host      Termux detected (android-platform), PREFIX=...
fail  Wake lock        termux-wake-lock not installed (without it Android suspends the Gateway when the screen turns off)
    -> pkg install termux-api
    -> Install the Termux:API app from F-Droid (...)
```

- `*` marks a capability the host cannot start without.
- `warn` means the host works with a smaller promise — worth reading, not worth
  panicking about.
- `->` lines are the commands to type. On Termux they are `pkg` commands; they
  are never `nvm` or a glibc toolchain, because those cannot work here.
- The `Reading these numbers on Android` footnote explains why a memory or core
  count that looks fine on a server is not fine here.

## Where state lives

Everything is under `~/.clawagent` (override with `CLAWAGENT_HOME` or
`--home`):

| Path | Contents |
| --- | --- |
| `clawagent.json` | configuration |
| `state/clawagent.sqlite` | sessions, memory index, cron state |
| `agents/<id>/sessions/` | per-agent JSONL transcripts |
| `logs/` | rotating JSON Lines logs |
| `credentials/` | provider keys and channel tokens |
| `media/`, `skills/`, `cron/`, `canvas/` | feature data |

Logs rotate at 2 MiB per generation and keep two generations, so a Gateway left
running for weeks cannot fill `/data`.

## Development

```sh
bash scripts/smoke-termux.sh        # no node_modules required; runs on-device
```

From the repository root, with workspace dependencies installed:

```sh
pnpm --filter clawagent test        # vitest, including cross-package contract tests
```

Contributor rules — the `.ts` import specifiers, the zero-dependency policy, the
import boundaries, and the Termux constraints that shape the code — are in
[`AGENTS.md`](./AGENTS.md). Read it before your first change; two of its rules
look like mistakes and are not.
