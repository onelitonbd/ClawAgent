# Termux-native rebuild plan: a new folder that grows OpenClaw feature by feature

Companion to [`TERMUX-MOBILE-PLAN.md`](TERMUX-MOBILE-PLAN.md) (the full-repo audit).
This document plans a **different strategy**: instead of porting `src/` to Android,
create one new folder and grow a Termux-native host that acquires OpenClaw
capabilities one milestone at a time.

Planning only — no code written. Audit date 2026-09-29 · Branch `arena/01a0eb13-clawagent`.

---

## 1. Why this is the better strategy

The audit established that porting `src/` means fighting **11,618 non-test
TypeScript files** (`src/gateway` alone is 1,996) across 112 `linux` / 103
`darwin` / 516 `win32` platform branches, plus launchd/systemd/schtasks,
Docker sandboxing, node-pty, Playwright, and two installers that both download
glibc binaries Android refuses to execute.

A new folder inverts the economics:

- Start at zero and **only ever add code that is already Termux-safe**.
- Never inherit a platform branch you did not choose.
- Ship something usable at milestone 1, not milestone 13.
- Keep `src/` untouched, so the desktop distribution cannot regress.

The risk of this strategy is normally "you will rewrite everything and end up
with a worse copy." **That risk is unusually low here**, for the reason in §2.

---

## 2. The key discovery: `packages/*` is already a Termux-safe core

I checked every workspace package for (a) native/transitive addon risk and
(b) imports escaping into `src/`. Result: **21 of 23 packages are production-clean
pure TypeScript with zero native dependencies.**

### Reuse directly — zero changes

| Package | What it gives you for free | Deps |
| --- | --- | --- |
| **`@openclaw/agent-core`** | **The actual agent loop.** `agent-loop.ts`, `agent.ts`, reasoning, stream steering, turn interruption, tool execution context, plus `harness/compaction` (`compact`, `prepareCompaction`, `estimateContextTokens`, `generateSummary`, `findCutPoint`), `harness/branch-summarization`, `buildSessionContext`, `uuidv7`, `kill-tree`. | ai, llm-core, normalization-core, typebox |
| **`@openclaw/ai`** | **The entire provider layer.** Anthropic, OpenAI Completions + Responses + ChatGPT-Responses (incl. WebSocket), Google Gemini + Vertex + Interactions, Mistral, Azure OpenAI, Cloudflare, GitHub Copilot headers, DeepSeek DSML, llama.cpp GBNF, generic OpenAI-compatible. All pure `fetch`. Plus tool-schema projection, prompt caching, usage accounting, retry-after. | @anthropic-ai/sdk, @google/genai, @mistralai/mistralai, openai, partial-json, typebox |
| **`@openclaw/gateway-protocol`** | Full TypeBox wire schema + validators: connect, approvals, cron, channels, devices, nodes, plugins, exec approvals, sessions, terminal, artifacts, theme, version. | typebox |
| `@openclaw/gateway-client` | WS client, browser build, device auth payload, scope upgrade. | gateway-protocol, ipaddr.js, ws |
| `@openclaw/sdk` | Client SDK: transport, event hub, run-event replay/reconnect, chat projection/stream, terminal outcome. *(Its only 3 `src/` imports are in `package.e2e.test-support.ts` — production-clean.)* | gateway-client, gateway-protocol, normalization-core, retry |
| `@openclaw/llm-core` | Model contracts, usage/cost, validation. | typebox |
| `@openclaw/terminal-core` | TUI primitives. | @clack/prompts, chalk, string-width |
| `@openclaw/markdown-core` | markdown-it + GFM tables + CJK-friendly. | markdown-it, mdast-util-*, micromark-*, yaml |
| `@openclaw/normalization-core` | **Already contains the correct Termux home-dir resolution** (`home-dir.ts:17-25`). | libphonenumber-js, typebox |
| `@openclaw/model-catalog-core` | Model catalog. | normalization-core, zod |
| `@openclaw/net-policy` | SSRF / IP policy guard. | normalization-core, ipaddr.js |
| `@openclaw/media-core` | Media type detection. | normalization-core, file-type |
| `@openclaw/media-generation-core`, `media-understanding-common` | Media contracts. | 0-1 deps |
| `@openclaw/tool-call-repair` | Repairs malformed model tool calls. | normalization-core |
| `@openclaw/retry` | Backoff. | **zero deps** |
| `@openclaw/session-url-contract`, `acp-core`, `workboard-contract`, `plugin-package-contract`, `mermaid-renderer` | Contracts + browser-side mermaid. | 0-3 deps |

### Do **not** reuse

| Package | Why |
| --- | --- |
| `@openclaw/plugin-sdk` | It is a **pure facade** — 62 files each doing `export * from "../../../src/plugin-sdk/X.js"`. Importing it imports `src/`. |
| `@openclaw/memory-host-sdk` | 77 production imports escaping into `src/agents/*`, `src/plugins/*`, `src/logging/*`. Genuinely coupled. Reimplement the small slice you need. |

### The decisive constraint: `extensions/*` cannot be lifted

Extensions import the **root package**, not the workspace libs:

```
1486×  from "openclaw/plugin-sdk/string-coerce-runtime"
1155×  from "openclaw/plugin-sdk/config-contracts"
 776×  from "openclaw/plugin-sdk/extension-shared"
 650×  from "openclaw/plugin-sdk/plugin-entry"
 ...   (~10,000 imports across 164 extensions)
```

`package.json` exposes **354 exports**, nearly all `./plugin-sdk/*`, backed by a
**654-file `src/plugin-sdk/`**. Depending on `openclaw` to load `extensions/telegram`
drags in all of `src/` — exactly what this strategy exists to avoid.

**Therefore: write channels directly against their upstream libraries** (`grammy`,
`@slack/bolt`, `baileys`, `discord-api-types`, `zod`). A Telegram bot is a few
hundred lines; the plugin-SDK adapter around it is not worth porting.

### The second decisive discovery: `ui/` works unmodified

`ui/src/api/gateway.ts` talks to a gateway exclusively through
`@openclaw/gateway-client/browser` + `@openclaw/gateway-protocol`. It has no
idea what serves the other end.

**So if the new host speaks the same WS protocol, the existing mobile-first
Control UI — `viewport-fit=cover`, `interactive-widget=resizes-content`, PWA
manifest, safe-area insets, `100dvh`, `@media (pointer: coarse)`, 768/640/560 px
breakpoints — works against it with zero UI work.** Milestone 4 buys a complete
mobile chat app for the price of ~8 protocol methods.

### Third: `agent-core` was designed for exactly this

`packages/agent-core/src/runtime-deps.ts:3` says so explicitly:

> *"Runtime functions injected by host packages so agent-core stays provider-agnostic."*

```ts
interface AgentCoreRuntimeDeps { streamSimple; completeSimple; runStream? }
```

And `AgentTool` at `packages/agent-core/src/types.ts:562` is the tool contract
the new host implements. The seam already exists.

---

## 3. Hard boundaries (non-negotiable rules for the folder)

1. **Never depend on the root `openclaw` package.** It transitively imports all of `src/`.
2. **Never import `extensions/*`.** ~10k `openclaw/plugin-sdk/*` imports.
3. **Never import `@openclaw/plugin-sdk` or `@openclaw/memory-host-sdk`.** Both escape into `src/`.
4. **Never add a native addon.** If one ever becomes unavoidable: `optionalDependencies`
   + runtime capability probe + documented fallback + a `doctor` line. Never a hard dep.
   (This is precisely how `@lydell/node-pty` and `@openclaw/fs-safe` break the main repo.)
5. **Never hardcode `/bin/*`, `/usr/*`, `/etc/*`, `/var/*`.** Resolve via `PATH` / `$PREFIX`.
6. **One owner for Termux detection.** A single module; everyone else consumes it.
7. **Every milestone ships a Termux smoke test** that runs on a real device.
8. **Use `node:sqlite` only.** No `better-sqlite3`, no addon.
9. **Use `child_process`, never a PTY.** Bionic has no node-pty prebuild.
10. **`packages/*` is a read-only dependency.** Do not patch it to suit the mobile
    host; if a package needs a change, that is a separate upstream-shaped PR.

---

## 4. Folder layout and workspace wiring

### Location

`pnpm-workspace.yaml` globs are: `.`, `ui`, `packages/*`, `extensions/*`, `examples/*`.
**`apps/*` is deliberately not a workspace member** (it holds Tauri/Swift/Kotlin
native apps). So:

- ❌ `apps/termux/` — would not resolve `workspace:*` deps without also editing the globs, and mixes a Node runtime in with native apps.
- ❌ `packages/<name>` — resolves automatically, but it is an application, not a library.
- ✅ **New top-level `mobile/`**, added to `pnpm-workspace.yaml` — exactly how `ui` is already wired. One-line change, precedented.

Name it `mobile/` rather than `termux/` because the scope (Termux host + PWA
reachability + `termux-api` + battery/doze behaviour) is "mobile", and it leaves
room to grow. Its README must state plainly that it is **not** `apps/android`
(the Kotlin companion node) — the two are complementary: this folder *is* the
Gateway; that app can later pair to it as a node (M12).

### Shape

```
mobile/
  README.md                 # what this is, what it is not, capability ledger
  package.json              # name: @openclaw/mobile, bin: { … }, type: module
  tsconfig.json             # extends ../config/tsconfig/oxlint.source.json
  AGENTS.md                 # the §3 hard boundaries, canonical for this tree
  src/
    platform/               # Termux/Android detection — the ONE owner
    config/                 # config load, state dir, env
    logging/                # stdout + rotating file, phone-sized
    cli/                    # commander/clack entrypoints
    llm/                    # AgentCoreRuntimeDeps wiring over @openclaw/ai
    tools/                  # AgentTool impls: read/write/edit/bash/glob/grep
    state/                  # node:sqlite schema + queries
    agent/                  # session orchestration over @openclaw/agent-core
    gateway/                # WS server speaking @openclaw/gateway-protocol
    termux/                 # termux-api wrappers + wake lock + service adapter
    channels/               # telegram/, irc/, slack/, … (direct, no plugin SDK)
    capability/             # the ledger: works / degraded / unsupported + why
  test/
  scripts/
    install-termux.sh       # pkg-based, no sudo, no glibc downloads
    smoke-termux.sh         # on-device acceptance run
```

### Wiring changes outside the folder (keep minimal)

| File | Change |
| --- | --- |
| `pnpm-workspace.yaml` | add `- mobile` to `packages:` |
| `config/tsconfig/oxlint.source.json` | add `../../mobile/**/*` to `include` |
| `tsconfig.json` `paths` | add `@openclaw/mobile/*` entries if cross-imports are needed (they should not be) |
| `.oxlintrc.json` / `.gitignore` | confirm coverage; add `mobile/dist` |
| `scripts/lib/tsdown-output-roots.mts` | **only if** you want it in the shared tsdown pipeline. Recommendation: **do not** — see §6 build strategy. |
| `docs/docs.json` + `docs/install/termux.md` | at M5, once it is installable |

---

## 5. The feature ladder

Thirteen milestones. Each one is independently shippable and independently
provable on a device. "Adopts" = reuse an existing package; "Builds" = new code.

### M0 — Skeleton that runs on Termux (~2-3 d)
- **Adopts:** `normalization-core` (Termux home-dir already correct), `retry`, `terminal-core`.
- **Builds:** `src/platform/` — the single Termux detector. Model it on
  `src/infra/wsl.ts` (`isWSLEnv` → `isWSLSync` → cached async `isWSL` → test reset).
  Signals: `process.platform === "android"`, `PREFIX` matching `com.termux/files/usr`,
  `ANDROID_DATA`. Plus `src/config/`, `src/logging/`, CLI skeleton.
- **Deliverable:** `<bin> --version` and `<bin> doctor` printing honest Termux facts
  (node version, `process.platform`, arch, `PREFIX`, RAM, free disk, battery, whether
  `termux-api` is installed, whether a wake lock is held).
- **Proof:** runs on a real device after `pkg install nodejs-lts git`. Nothing downloads glibc.
- **Note:** `doctor` is the capability ledger's first surface — start it here, grow it every milestone.

### M1 — One provider, streaming chat in the terminal (~2-3 d)
- **Adopts:** `@openclaw/ai` (this is the big payoff — Anthropic/OpenAI/Google/Mistral/Azure/Cloudflare/OpenAI-compatible already exist), `llm-core`, `markdown-core`.
- **Builds:** `src/llm/` implementing `AgentCoreRuntimeDeps`; API-key config; token streaming to terminal; markdown rendering.
- **Deliverable:** `<bin> ask "…"` streams a rendered answer.
- **Proof:** one live call each to Anthropic and OpenAI on device.

#### M1 as built — and what it changed

**The build decision.** ClawAgent composes the shared cores *from source* rather
than reimplementing or vendoring them. Three pieces make that work on a device
with no build step:

1. `ClawAgent/src/runtime/source-resolution.ts` installs a `module.registerHooks`
   resolve hook that maps `@openclaw/*` onto `packages/*/src` and rewrites a
   relative `.js` specifier to the `.ts` file that actually exists.
2. `bin/clawagent.mjs` re-executes itself with `--experimental-transform-types`,
   because `ai` and `retry` use TypeScript parameter properties that strip-only
   mode rejects outright.
3. `ClawAgent/package.json` declares the cores as `workspace:*` **and** their
   external npm dependencies at the versions the cores pin.

The precedent for 1 is the repository's own `test/vitest/vitest.shared.config.ts`,
which already aliases these cores to source for tests. The alternatives were all
worse and are recorded in `ClawAgent/AGENTS.md`: bundling on the device needs a
native toolchain; committing a bundle cannot be reviewed and drifts; vendoring
rewritten copies duplicates thousands of files and guarantees the behavioural
drift this rebuild exists to avoid.

**Three findings that the plan did not anticipate.**

- *A package's `exports` map is authoritative, and dist paths are not flat.*
  `@openclaw/llm-core/event-stream` declares `./dist/utils/event-stream.mjs`, so
  its source is `src/utils/event-stream.ts`. A resolver that guessed
  `src/<subpath>.ts` mapped it to nothing, which made `@openclaw/ai/providers` —
  and therefore all of chat — unloadable. The hook now derives source paths from
  the declared target, with the flat layout only as a fallback.
- *Declared dependencies are not the real requirement.* `packages/ai` declares no
  `@openclaw/*` dependency at all, yet its source imports `llm-core`,
  `media-core`, `model-catalog-core`, and `normalization-core`. The reuse
  manifest therefore separates what ClawAgent imports from what it loads, and
  `reused-packages.ts` recomputes the external set so the boundary test fails on
  drift instead of on a device.
- *Vendor SDKs load lazily.* `registerBuiltInApiProviders` installs adapters that
  `await import()` their module on first use, so startup touches only `typebox`.
  That is why `doctor` and `chat --help` stay fast on a phone, and it is also why
  a missing SDK surfaces at the first turn rather than at startup — which the
  error text now says.

**Delivered.** `clawagent chat`, interactive and one-shot (`-m`), streaming
deltas as they arrive; Anthropic, OpenAI, Google, Mistral, and any
OpenAI-compatible endpoint including a LAN model server; key resolution from an
override variable, a `credentials/api-keys.json` file (with a warning when it is
readable by others), or the provider's conventional variable; config from
`clawagent.json` with environment and flag overrides; and errors classified into
network / auth / rate-limit / model so a mobile failure says what to check.

**Deviations from the plan above.**

- The command is `chat`, not `ask` — it holds a conversation, not one question.
- `src/llm/` implementing `AgentCoreRuntimeDeps` was **not** built. That
  interface is the agent loop's dependency surface, and the loop is M2; wiring to
  it now would mean inventing an agent that does not exist. M1 has a thinner seam
  (`src/provider/runtime.ts`) that M2 will adapt.
- `markdown-core` was **not** adopted. Streaming markdown into a terminal needs
  `terminal-core` and reflow logic that is cosmetic next to getting a reply at
  all; it moves to M2.
- Exit codes grew: `3` config or credentials unusable, `4` the turn failed.

**Proof status — incomplete, stated plainly.** Proven here: every production
module loads through the hook; `@openclaw/ai` and `@openclaw/ai/providers`
resolve and start with no network; the full chain reaches the vendor SDK's HTTP
layer (verified with an invalid key, which returned the SDK's own connection
error through the classifier); 526 unit tests and 82 on-device smoke checks pass.
**Not** proven: the plan's "one live call each to Anthropic and OpenAI on
device". This sandbox has no egress to provider APIs and is not an Android
device, so a live streaming call on real hardware is still outstanding and is the
first thing to verify on a phone.

### M2 — Agent loop + tools + approvals (~4-6 d)
- **Adopts:** `@openclaw/agent-core` (agent loop, reasoning, stream steering, turn interruption), `tool-call-repair`.
- **Builds:** `src/tools/` implementing `AgentTool` (`types.ts:562`) for `read`, `write`, `edit`, `bash`, `glob`, `grep`. **`bash` uses `child_process` + PATH resolution, never `/bin/sh`, never a PTY.** Approval prompts via `terminal-core`.
- **Deliverable:** a multi-turn tool-using agent in the terminal that can edit files in a workspace.
- **Proof:** scripted task ("create a file, read it back, fix a bug in it") completes with approvals honoured.
- **This is the milestone that makes it an agent rather than a chat client.**

#### M2 as built — and what it changed

**The build decision.** The loop is `Agent` from `@openclaw/agent-core`, composed
from source like everything else in M1, with two hooks doing the work ClawAgent
owns: `beforeToolCall` consults the approval gate and can block a call before it
runs, and `afterToolCall` enforces the per-message turn cap. Nothing in
`packages/agent-core` was edited. Around it: `src/tools/` (six tools behind one
containment boundary), `src/approvals/` (a pure policy plus a prompt gate), and
`src/cli/agent.ts`.

**Delivered.** `clawagent agent`, one-shot (`-m`) and interactive; the six tools
(`read`, `write`, `edit`, `glob`, `grep`, `bash`); four approval modes
(`read-only`, `workspace`, `ask`, `full`) plus `--yes`, with aliases a person
recognises from other tools (`plan`, `auto-edit`, `yolo`); session grants per tool
on `a`; a workspace root with a strict path policy; `--dry-run`, which prints the
plan and calls nothing; a turn cap defaulting to 24 and capped at 200; provider
failures classified the way `chat` classifies them, with the session surviving the
failure so the user can retry.

**Four deviations from the plan above.**

- **Approvals do not use `terminal-core`.** Its styled select wraps
  `@clack/prompts`, which needs a raw-mode TTY and reports `terminal=false` when
  stdin is redirected — which is exactly how every gate here runs, and how a
  scripted task is proven. It would also have added three dependencies to teach a
  phone a UI library. Approvals share the queue-based readline prompter `chat`
  already uses; EOF means "no", three unparseable answers mean "no". If a later
  milestone wants the styled prompt, it has to survive a non-TTY first.
- **`bash` refuses shell operators instead of quoting around them.** `;`, `&&`,
  `|`, `>`, and `$(...)` are parsed out and rejected with a hint, rather than
  being passed through to something that would mis-execute them. There is no
  shell to be sorry about.
- **Tool-call *repair* is wired, *promotion* is not.**
  `stripPlainTextToolCallBlocks` runs on assistant text, because a model that
  writes a tool call as prose otherwise silently does nothing. Promotion —
  detecting a fenced call in text and turning it into a real call — needs
  `markdown-core`'s code-region protection so a fenced example in the answer is
  never read as an instruction, plus ~150 lines of iterator plumbing. It moves to
  a later milestone rather than being guessed at.
- **`read`/`glob`/`grep` never ask**, in any mode. An approval prompt for a
  directory listing trains the user to answer prompts without reading them, and
  the tools cannot write. `read-only` accordingly has three tools, not six.

**Three findings that only running it produced.**

- *Declared dependencies are still not the real requirement, one level deeper.*
  `@openclaw/agent-core` reaches `@openclaw/ai`, whose source imports
  `../../../markdown-core/src/reasoning-tags.js` by relative path — a cross-package
  import no `exports` map or `dependencies` block records. Anything that loads the
  loop therefore needs `markdown-core` plus `mdast-util-from-markdown`,
  `mdast-util-gfm-table`, and `micromark-extension-gfm-table`. The load closure
  (`SOURCE_LOAD_CLOSURE`) and the two override records (`LOAD_PATH_DEPENDENCIES`,
  `UNDECLARED_DEPENDENCIES`) exist so this is a checked set rather than folklore.
- *The install line in the README was broken, and the tests enforced the breakage.*
  `package.json` listed the reused cores with `workspace:*`, a pnpm protocol; on a
  phone, `npm install --omit=dev` fails with `EUNSUPPORTEDPROTOCOL` before it
  downloads anything. The M1 boundary test *required* that range, so the suite was
  green while the documented install was impossible. The cores now live in the
  `clawagent.reusedPackages` block, `dependencies` holds only registry packages,
  and a new test fails on any non-registry range so this class of bug cannot come
  back quietly.
- *`doctor` could not run before an install.* The same M2 wiring put `typebox` in
  the static import closure of `src/cli/main.ts` (via the tool layer), so
  `clawagent version`, `help`, and `doctor` all died with `ERR_MODULE_NOT_FOUND` on
  a fresh clone — the one state doctor exists to diagnose. The tool layer is now
  imported where it is used, and the boundary test walks the startup closure to
  keep it that way.

**Proof status — stated plainly.** The plan's proof is met in the sandbox: a
scripted task (write `sum.js`, read it back, fix the bug) completes through the
real loop against real files with a faked transport, approvals are honoured per
tool, a declined `write` leaves no file and still ends `ok`, `rm -rf /` is refused
with no prompt in `full`, and the turn cap stops a runaway script with a
`stoppedReason` rather than an error. 748 unit tests, 0 typecheck errors in
`ClawAgent/`, and 117 smoke checks pass, including a run against a
device-shaped tree (nothing above the package but its own `node_modules`).

**Not proven, and unchanged from M1:** a live model call from an Android device.
M2 adds a second unknown of the same kind — this loop has never run on Bionic — so
the first phone session should run `clawagent agent --dry-run`, then a one-shot
task, before anything is trusted with a real workspace.

### M3 — Persistence: sessions, transcripts, compaction (~3-4 d)
- **Adopts:** `agent-core` compaction (`compact`, `prepareCompaction`, `estimateContextTokens`, `generateSummary`, `findCutPoint`), `session-url-contract`.
- **Builds:** `src/state/` on `node:sqlite` (built into Node 24 — no addon, no compile). Schema: sessions, messages, tool calls, usage. Resumable transcripts.
- **Deliverable:** conversations survive process restart; long conversations compact instead of blowing the context window.
- **Proof:** kill -9 the process mid-conversation, restart, resume with history intact; force a compaction and verify the summary.

### M4 — Gateway: WS server, and the Control UI lights up (~5-7 d)
- **Adopts:** `@openclaw/gateway-protocol` (TypeBox validators — implement against the schema, do not invent frames), `net-policy`.
- **Builds:** `src/gateway/` — loopback-bound WS server, token auth, and a **deliberate method subset**: `connect`, `chat.startup`, `chat.send`, `chat.history`, `chat.abort`, `agents.list`, `config.get`, `approval.resolve`. Serve the already-built `ui/` assets over HTTP.
- **Deliverable:** **open `http://127.0.0.1:<port>` in the phone's Chrome and chat with your agent through the existing mobile-first PWA. Add to home screen → fullscreen app.**
- **Proof:** screenshot of the Control UI on a device, plus a chat round-trip and an approval resolved from the UI.
- **Highest visible-value milestone.** Zero UI code written; `ui/` is reused as-is because it only knows `gateway-client`.
- **Discipline:** return a clear "not implemented on this host" protocol error for every method outside the subset. The UI must degrade legibly, never hang.

### M5 — Survive Android: lifecycle, memory, battery (~4-5 d)
- **Builds:** `src/termux/` lifecycle layer.
  - **Wake lock** — acquire `termux-wake-lock` on start, release on clean shutdown, report in `doctor`. *Without this, Doze kills the Gateway every time the screen turns off. This single feature is the difference between a demo and an assistant.*
  - **Service adapter** — `termux-services` (`sv up/down/status` against `$PREFIX/var/service/<name>`), with a `setsid`/`nohup` fallback.
  - **Autostart** — emit `~/.termux/boot/start-openclaw.sh` (Termux:Boot), including the wake-lock call.
  - **Android resource profile** — do **not** copy the main repo's numbers. `src/daemon/gateway-heap.ts` gives V8 `--max-old-space-size=4096` because `os.totalmem()` on Android returns *device* RAM; `src/config/agent-limits.ts` computes **32 concurrent agent runs** from `availableParallelism()*4` on an octa-core phone. Cap both, driven by real available memory and battery state.
  - **Battery-aware throttling** via `termux-battery-status`.
- **Deliverable:** Gateway survives screen-off and app-kill, and restarts on boot.
- **Proof:** **24-hour survival test** — screen off, on battery, then a reboot. Cannot be shortened or simulated; budget real elapsed time.

### M6 — Feel native: `termux-api` (~3-4 d)
- **Builds:** one owner module that probes `termux-api` once, then typed wrappers that degrade to a no-op **with a reason**, never a throw.
  - `termux-notification` → **a local notification channel: the assistant reaches you with no external chat service configured.** Highest UX value per line of code in the whole plan.
  - `termux-open-url` → `dashboard` actually opens the phone browser.
  - `termux-clipboard-set`/`-get`, `termux-vibrate` (approval haptics), `termux-tts-speak` (spoken replies with no cloud TTS), `termux-share`/`termux-open` (hand generated files to any Android app).
- **Deliverable:** notifications, haptics, TTS, share-sheet, clipboard all work.
- **Proof:** a video/gif of an approval arriving as an Android notification and being resolved by tap.

### M7 — First channel: Telegram (~2-3 d)
- **Builds:** `src/channels/telegram/` directly on `grammy` (already a root dep, pure TS: grammy, undici, zod, typebox, `@grammyjs/transformer-throttler`). Define your own minimal channel contract — inbound message → agent run → outbound reply, with per-channel delivery limits.
- **Do not** port `extensions/telegram` (see §2).
- **Deliverable:** message your assistant from Telegram; it answers with tools.
- **Proof:** round-trip on device over mobile data (not Wi-Fi — that is the real use case).

### M8 — More channels, cheapest first (~1-2 d each)
Ordered by dependency weight and Termux safety, all verified against
`extensions/*/package.json`:

| Channel | Deps | Termux verdict |
| --- | --- | --- |
| IRC | `zod` only | ✅ trivial |
| SMS | `zod` only (HTTP API) | ✅ trivial |
| Line | `@line/bot-sdk` | ✅ pure |
| Google Chat | `google-auth-library` | ✅ pure |
| Slack | `@slack/bolt`, `web-api` | ✅ pure (Socket Mode over ws) |
| Discord | `discord-api-types`, `ws`, `libopus-wasm` | ✅ text fine; voice is WASM opus, verify separately |
| WhatsApp | `baileys` | ✅ **`pnpm-workspace.yaml` already overrides `baileys>sharp` to `"-"`** — the native image dep is stripped, so baileys is pure TS here |
| Mattermost / Nextcloud Talk / Nostr | `zod`, `nostr-tools` | ✅ pure |
| Matrix | `@matrix-org/matrix-sdk-crypto-nodejs` | ❌ native, no android build |
| Signal | needs `signal-cli` (Java) | ⚠️ possible via `pkg install openjdk`, document as advanced |
| iMessage | requires macOS host | ❌ out of scope |

### M9 — Skills, cron, heartbeat (~3-4 d)
- **Builds:** skill loader for the repo's existing `skills/` markdown+frontmatter format (reuse `markdown-core`; the format is already documented and there are 49 skills to test against). Scheduler on `croner` (already a root dep, pure JS). Heartbeat with a phone-appropriate default interval.
- **Deliverable:** install a skill from `skills/`, schedule a recurring job, get its result as a notification.
- **Proof:** a cron job fires while the screen is off and notifies.

### M10 — Memory and media (~4-5 d)
- **Builds:** markdown-file memory first — no `sqlite-vec`, no LanceDB, no native anything. Reimplement only the small slice of `memory-host-sdk` you need (it is not reusable as-is).
- **Adopts:** `media-core` (file-type), `media-generation-core`, `media-understanding-common`. Images in/out through provider APIs (`@openclaw/ai` already handles media payloads) — no local ffmpeg required initially.
- **Optional later:** build `sqlite-vec` from source with Termux clang for vector recall. Treat as an enhancement, never a dependency.
- **Deliverable:** the agent remembers facts across sessions; you can send it a photo.

### M11 — Web tools (~3-4 d)
- **Builds:** `web_fetch` (undici + `@mozilla/readability` + `linkedom` — all pure JS, all already root deps) and `web_search` (Brave/DuckDuckGo/Exa HTTP). Guard both with `@openclaw/net-policy`.
- **Browser automation:** skip Playwright entirely. **Optional opportunity:** a CDP bridge to the phone's *real* Chrome on `localhost:9222` — Android already has a browser, which is a better answer than shipping Chromium.
- **Deliverable:** agent can fetch and search the web.

### M12 — Nodes: pair the existing Android app (~4-6 d)
- **Adopts:** `gateway-protocol` node/device validators, `acp-core`, `workboard-contract`.
- **Builds:** device pairing + node command dispatch, so **`apps/android` (the existing Kotlin companion) can pair to this Gateway** and lend the phone's camera, location, SMS, and screen to the agent.
- **Deliverable:** the Termux Gateway and the native Android app work together — one hosts, one senses. This is the topology the main repo cannot express today.
- **Proof:** a photo taken via the paired node, described by the model.

### M13 — Provider breadth and local models (~2-3 d, mostly config)
- **Adopts:** the rest of `@openclaw/ai` — Google, Mistral, Azure, Cloudflare, OpenAI-compatible are already written; this is enabling and testing them.
- **Local models:** Ollama over LAN (a phone cannot host a useful local model, but it can reach one on your network). `extensions/ollama-provider` depends only on `typebox`, so its logic is easy to reimplement.
- **Deliverable:** model picker with several providers working on device.

---

## 6. Cross-cutting concerns

### Build and run strategy on device

Building the main repo on a phone is infeasible (tsdown over 11k files,
`--max-old-space-size=8192` in `scripts/lib/cross-os-release-checks/`). The new
folder must not inherit that.

- **Develop on-device with Node's native TypeScript type stripping.** Node 24 runs
  `.ts` directly, and `tsconfig.json` already sets `verbatimModuleSyntax: true`,
  `allowImportingTsExtensions: true`, `module: NodeNext` — a style that is largely
  erasable-syntax-compatible. **Verify this on device early in M0**: no enums, no
  namespaces, no parameter properties, in `mobile/` *or* in the `packages/*` it imports.
  If a reused package uses non-erasable syntax, that is an M0 blocker to surface immediately.
- **Source-level resolution during development.** `tsconfig.json` `paths` already maps
  `@openclaw/ai` → `./packages/ai/src/index.ts`, so imports resolve to source with no build step.
- **Ship a single bundled file for release.** `esbuild` publishes `@esbuild/android-arm64`
  (plus `android-arm` and `android-x64`), so bundling *on* device works if ever needed.
  Prefer bundling in CI and shipping `dist/`.
- **Stay out of the shared tsdown pipeline** (`scripts/lib/tsdown-output-roots.mts`
  is an explicit 16-name allowlist that throws on unknown names). Independent build
  = independent failure domain.

### The capability ledger

One machine-readable table, owned by `src/capability/`, surfaced by `doctor` and
by the Control UI: every feature is `works` / `degraded` (with what is lost) /
`unsupported` (with why). This is what makes a partial implementation feel
deliberate instead of broken — and it directly fixes the main repo's worst mobile
symptom, where browser tools, sandboxing, and vector memory vanish *silently*.

Seed it from the audit: sandbox → unsupported (no Docker without root); PTY terminal
→ unsupported (no Bionic node-pty); browser → unsupported until the CDP bridge;
Matrix → unsupported (native crypto addon).

### Distribution

`scripts/install-termux.sh` inside `mobile/`, following the audit's rules:
`pkg`-based, **no `sudo`**, **no glibc downloads**, no `nvm`. It must check the
Node floor (`>=24.16.0 <25 || >=26.1.0`, per `node-version.mjs`) and print
`pkg upgrade nodejs-lts` rather than the main installer's `nvm install 26`.

Publishing to npm as its own package is optional and can wait until M5.

### Testing

- Unit tests reuse the repo's vitest setup.
- **A real-device smoke script (`scripts/smoke-termux.sh`) is a first-class
  deliverable from M0**, not an afterthought — it is the only way any of this is
  provable. It should print a pasteable report (node version, platform, arch,
  `PREFIX`, RAM, disk, battery, `termux-api` presence, wake-lock state) then run
  each milestone's proof.
- Add a CI gate that fails if `mobile/` gains a dependency with a native addon,
  or an import from `openclaw/*`, `../../src/*`, or `extensions/*`. This is cheap
  and it is the mechanism that keeps the boundaries in §3 from eroding. The repo
  already has this pattern: `src/infra/fs-safe-import-boundary.test.ts`.

---

## 7. Sequencing and effort

| Milestone | Cumulative capability | Effort |
| --- | --- | --- |
| M0 | Runs on device, honest doctor | 2-3 d |
| M1 | Streaming chat with a real model | 4-6 d |
| M2 | **An agent with tools and approvals** | 8-12 d |
| M3 | Persistent, resumable, compacting sessions | 11-16 d |
| M4 | **Full mobile chat UI in the phone browser (PWA)** | 16-23 d |
| M5 | **Survives screen-off and reboot** | 20-28 d |
| M6 | Notifications, TTS, haptics, share | 23-32 d |
| M7 | Telegram | 25-35 d |
| M8 | +6 more channels | 31-45 d |
| M9 | Skills, cron, heartbeat | 34-49 d |
| M10 | Memory + media | 38-54 d |
| M11 | Web fetch/search | 41-58 d |
| M12 | Pairs with the native Android app | 45-64 d |
| M13 | Provider breadth + LAN local models | 47-67 d |

**~47-67 engineering days** for feature parity with the parts of OpenClaw that
matter on a phone — versus the audit's 22-28 days to merely make the *existing*
codebase installable, before any of it behaves well.

The two are not mutually exclusive. Recommended reading: the audit's Phase 0
(installer refusals, so users get a correct error instead of a broken glibc
download) is worth doing regardless, and is ~2 days. Everything else in the
audit is superseded by this plan.

**Two natural checkpoints:**
- **M2 (~2 weeks)** — a real tool-using agent in Termux. Proves the whole thesis.
- **M5 (~5 weeks)** — a persistent, always-on, phone-native assistant with a PWA UI and Telegram. This is the "product" milestone.

---

## 8. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Termux's `nodejs-lts` lags the `>=24.16.0` floor | High | Check first thing in M0. If it lags, either wait for `pkg upgrade`, or ask upstream to relax the floor **for this package only** — the floor exists for a real `node:sqlite` TEXT/BLOB correctness reason (`node-sqlite.mjs` capability probe), so it must not be moved globally. |
| A reused `packages/*` uses non-erasable TS syntax, breaking on-device type stripping | Medium | Verify in M0. Fallback: bundle with esbuild (`@esbuild/android-arm64` exists) instead of running source. |
| `ui/` calls protocol methods outside the M4 subset and hangs | Medium | Return explicit "unsupported on this host" protocol errors for every unimplemented method. Test the UI against the subset before declaring M4 done. |
| `gateway-protocol` evolves and the two hosts diverge | Medium | Implement against the shared TypeBox validators, never hand-rolled frames. Add a contract test that runs the same fixtures against both hosts. |
| Scope creep toward "just port `src/` after all" | High | §3 boundaries + the CI gate in §6. Any PR importing `openclaw/*` or `../../src/*` fails automatically. |
| Android kills the process regardless of wake lock (OEM battery managers) | Medium | M5 must test on at least two OEMs. Document per-OEM battery-allowlist steps; this is a known Termux problem, not an OpenClaw one. |
| Duplicate-maintenance burden: two hosts forever | High | Accept it deliberately. The shared surface is `packages/*` + `gateway-protocol` + `ui/`, which is where the real complexity lives. The mobile host owns only thin glue. Re-evaluate at M13 whether the two can converge. |

---

## 9. Decisions I need from you

1. **Folder name and CLI binary name.** I propose `mobile/`; the binary needs a
   name that will not collide with `openclaw` on a machine that has both.
2. **M4 protocol strategy: subset or fork?** Subset (recommended) reuses `ui/`
   for free but means the Control UI shows features that error. A fork means
   writing a mobile UI — much more work, and it throws away an already-good PWA.
3. **Does M12 (pairing the existing `apps/android` Kotlin app) matter to you?**
   It is the most interesting capability in the plan and the one the main repo
   structurally cannot offer, but it is also the most work.
4. **How much of the audit's Phase 0 should I do anyway?** The installer refusals
   (~2 days) protect users who try the main package on Termux today, independent
   of everything here.

I can start M0 as soon as 1 and 2 are settled. M0 is small, self-contained, and
its output — a real device report — de-risks every later milestone.
