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

**M2 — the agent loop, with tools and approvals.** The skeleton from M0, the
streaming chat from M1, and now an agent that reads, writes, edits, and runs
things inside a workspace you approve.

Working today:

- Detects Termux and Android, including the cases where `HOME` is unset and
  `os.homedir()` lies.
- `clawagent doctor` reports what this specific device can and cannot do, with
  the exact `pkg` command to fix each gap. It runs on a fresh clone, before
  `npm install`, so it is the command that can explain a broken install.
- `clawagent chat` streams a reply token by token, interactively or one-shot.
- `clawagent agent` runs a task to completion: a model that asks for a `write`,
  a `read`, an `edit`, a `glob`, a `grep`, or a `bash` command, with every
  mutating step gated by the approval mode you chose.
- Composes the repository's shared cores (`@openclaw/agent-core`, `ai`,
  `llm-core`, `tool-call-repair`, `normalization-core`, ...) **from source**, so
  the agent loop, provider protocols, retries, and path rules are the same code
  the desktop host runs rather than a copy of them.
- Anthropic, OpenAI, Google, Mistral, and any OpenAI-compatible endpoint
  (including a model server on your LAN).
- Resolves and creates the state directory (`~/.clawagent` by default).
- Bounded, rotating JSON Lines logs.
- A smoke test that runs on a phone with nothing installed but Node.

Not built yet: sessions, the Gateway, channels, and skills. The milestone ladder
(M0–M13) and the reasoning behind it are in
[`../TERMUX-REBUILD-PLAN.md`](../TERMUX-REBUILD-PLAN.md).

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
cd <repository>/ClawAgent

npm install --omit=dev        # the vendor SDKs the shared cores call
node bin/clawagent.mjs doctor
```

`doctor` exits `0` when this device can run the host, `1` when it cannot, and
`2` on a usage error. Add `--json` for machine-readable output.

Every dependency is pure JavaScript — no native addons, no compiler, no
`build-essential`. `npm install` on a phone is a download, not a build.

What that install fetches is only the vendor SDKs (`openai`, `@anthropic-ai/sdk`,
and the few parsers the cores use). The `@openclaw/*` cores themselves are never
installed: the entry point resolves them from `../packages/*/src` in this
checkout, which is why the clone matters and why `package.json` lists them under
`clawagent.reusedPackages` instead of under `dependencies`. Putting them in
`dependencies` would require a `workspace:*` range, and that protocol is
pnpm-only — it makes `npm install` fail outright with `EUNSUPPORTEDPROTOCOL`,
which is precisely the way a documented install path stops being one.

## Running a task with `agent`

`chat` answers questions. `agent` does the thing: it runs a loop where the model
asks for a tool, the tool runs, and the result goes back to the model, until the
task is done or you say no.

```sh
cd ~/projects/notes                      # the workspace is where it may touch
node ~/ClawAgent/ClawAgent/bin/clawagent.mjs agent \
  -m "rename every getUserName to getUsername and tell me what changed"
```

It can run one task and exit (`-m`), or take turns from a prompt (`agent` with no
`-m`), where `/tools`, `/workspace`, `/approve <mode>`, `/help`, and `/exit` are
available.

| Tool | What it does | Needs approval |
| --- | --- | --- |
| `read` | Reads a file, numbered lines, paged with `offset` | no |
| `glob` | Finds files by pattern | no |
| `grep` | Searches inside files | no |
| `write` | Creates or replaces a file | yes, unless `full` — or `workspace` with the path inside |
| `edit` | Replaces exact text, all edits applied or none | same as `write` |
| `bash` | Runs one program with arguments — **no shell** | always, see below |

### Approval modes

`--approve` (or `agent.approve` in the config, or `CLAWAGENT_APPROVE`) picks how
much the agent may do without asking:

| Mode | Meaning |
| --- | --- |
| `read-only` | The mutating tools do not exist for this run. Not refused — absent, so the model never wastes a turn proposing them. |
| `workspace` | Writes and edits inside the workspace go ahead; anything outside is refused. `bash` still asks. |
| `ask` | The default. Every `write`, `edit`, and `bash` is shown and confirmed, with `a` to allow for the rest of the session for that tool. |
| `full` | Nothing routine is asked. `--yes` is the shorthand for it. |

Two things no mode can talk past, because a mode decides who has to *ask*, not
whether an operation is reversible:

- a path outside the workspace is refused by the tool itself — in every mode,
  `full` included, since there is nothing worth asking about;
- a `bash` command on the destructive list is refused — `rm -rf /`,
  recursive-force removal, `mkfs`, `dd of=/dev/...`, fork bombs, `chmod 777 /`,
  and package-manager lock bypasses.

And one thing that is never *auto*-approved: a `write` or `edit` onto a credential
or key file (`~/.ssh`, `.npmrc`, `.netrc`, `authorized_keys`, and friends) is
asked for even in `full`, because "yes to everything" is not the same statement as
"yes, to that one".

`bash` never goes through `/bin/sh`, so there is no `;`, no pipe, and no
`$(...)` to be tricked by; the command line is split into argv, the program is
found on `PATH`, and the process group is killed if it exceeds the timeout.
Unknown `--approve` values are a usage error (exit `2`) that lists the modes,
never a silent fallback to something more permissive.

Before you let it edit anything you care about, see exactly what a run would do:

```sh
node bin/clawagent.mjs agent --dry-run --approve workspace --workspace ~/notes
```

```
workspace: /data/data/com.termux/files/home/notes (strict paths)
approval : workspace
model    : Anthropic Claude
tools    : read, write, edit, glob, grep, bash
turns    : up to 24 per message

no model call was made
```

## Talking to a model

```sh
export ANTHROPIC_API_KEY=sk-ant-...
node bin/clawagent.mjs chat
```

Or one line, with nothing exported:

```sh
CLAWAGENT_API_KEY=sk-ant-... node bin/clawagent.mjs chat \
  --provider anthropic --model claude-sonnet-4-5 -m "explain termux in one sentence"
```

Inside the chat, `/help`, `/model`, `/system`, `/clear`, and `/exit`. Ctrl-C
aborts the turn in flight; Ctrl-D leaves.

To keep the setting instead of typing it, write `~/.clawagent/clawagent.json`:

```json
{
  "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
  "chat": { "systemPrompt": "Answer briefly.", "temperature": 0.3 }
}
```

Keys are looked up in this order: `CLAWAGENT_API_KEY`, then
`~/.clawagent/credentials/api-keys.json` (`{"anthropic": "sk-ant-..."}`, and
`chmod 600` it — ClawAgent warns if it does not), then the provider's own
variable such as `ANTHROPIC_API_KEY`. Nothing ever prints a key in full.

A model server on your network works too, with no preset:

```sh
node bin/clawagent.mjs chat --api openai-completions \
  --base-url http://192.168.1.20:8080/v1 --model qwen-local -m "hi"
```

Exit codes: `0` success, `2` usage, `3` config or credentials unusable, `4` the
model turn failed. A failed turn inside an interactive chat does **not** end the
session or the conversation — it reports the error and lets you retry, because
losing a conversation to one dropped mobile connection is the worst thing this
could do.

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
