# Termux / Android hosting plan for OpenClaw

Full-repo audit + phased plan to make OpenClaw install, boot, and stay alive on a
phone running Termux, and to make the mobile experience genuinely good.

Audit date: 2026-09-29 · Branch: `arena/01a0eb13-clawagent` · Base: `d3008b2`
Scope: whole repo (50,548 files / 895 MB), with focus on `src/`, `packages/`,
`scripts/`, `ui/`, `docs/`, `package.json`, `pnpm-lock.yaml`.

---

## 1. Verdict

**OpenClaw cannot be installed or run on Termux today.** It is not a small gap —
there is no Android host path at all. Two separate failures happen before the
Gateway ever starts:

1. `scripts/install.sh` misroutes Termux to the desktop-Linux path and dies on `sudo`.
2. `scripts/install-cli.sh` downloads an official glibc Node tarball, which the
   Android kernel refuses to execute.

Even with a hand-made install, the runtime is silently wrong in ~112 places
because nothing in production code asks "am I on Android?".

**The good news:** the hard parts are already right. `node:sqlite` (built into
Node 24+) removes the classic `better-sqlite3` blocker. `@openclaw/fs-safe` has a
portable JS fallback. `koffi` and `esbuild` both ship `android-arm64` builds.
Exec already degrades PTY→child. And the Control UI is already a real
mobile-first PWA. This is a **platform-port + lifecycle-port** job, not a rewrite.

### Stated assumption

I read "run on Termux" as **hosting the Gateway on the phone itself**. The three
existing `scripts/termux-*.sh` widgets assume the opposite (a phone that SSHes to
a desktop Gateway); they stay useful but are not the goal here. Section 8 covers
the client-side case separately.

---

## 2. Why Termux is not "just Linux"

Four facts drive everything below. All four are verified against the repo and
against upstream reports.

| Fact | Consequence |
| --- | --- |
| `process.platform === "android"`, `process.arch === "arm64"` | Every `=== "linux"` branch is skipped; every `!== "linux"` branch is taken. |
| Bionic libc, **no glibc**. Android's kernel rejects glibc ELF (`unexpected e_type: 2`) | Any prebuilt `linux-arm64` native addon or Node tarball is dead on arrival. |
| `uname -s` → `Linux`, `$OSTYPE` → `linux-android`, no `/bin`, no `/usr/bin`, no `sudo`, no systemd | Shell-based detection lies; hardcoded absolute paths ENOENT; no service manager. |
| Android LMK + Doze, no swap, no cgroup quota | A server-sized heap and 32-way concurrency get the process killed with the screen off. |

---

## 3. What already works (protect these)

Do not regress these. They are the foundation the plan builds on.

| # | Where | What it does |
| --- | --- | --- |
| 1 | `packages/normalization-core/src/home-dir.ts:17-25` `resolveTermuxHome()` | Resolves `$PREFIX/../home` when `PREFIX` ends `com.termux/files/usr` **and** `ANDROID_DATA` is set. Correctly rejects `/tmp/com.termux/usr` false positives. Tested at `src/infra/home-dir.test.ts:88-125`. |
| 2 | `src/agents/utils/tools-manager.ts:358,396` | The **only** host-platform Android check in production code. Skips downloading glibc `fd`/`rg` and prints `pkg install <name>` instead. |
| 3 | `src/infra/exec-authorization-plan.ts:128` | `normalizePlanningPlatform()` accepts `"android"` as a valid `NodeJS.Platform`. |
| 4 | `src/agents/bash-tools.exec-runtime.ts:879-901` | PTY spawn failure → logs a warning, sets `usingPty = false`, retries with `mode: "child"`. **This is what keeps the exec tool alive on Termux.** |
| 5 | `node-runtime-update.mjs:7-17` `canInstallPrivateNode()` | Returns `false` for Android (requires `linux`+glibc report, `darwin`, or `win32`). Will not auto-download a broken Node. |
| 6 | `src/infra/browser-open.ts:87` | Returns `{ argv: null, reason: "unsupported-platform" }` instead of throwing. |
| 7 | `@openclaw/fs-safe` `dist/native-fallback-warning.js` + `FS_SAFE_NATIVE_MODE` | Portable JS fallback per capability, warning once. Verified by unpacking `0.21.1`. |
| 8 | `packages/memory-host-sdk/src/host/sqlite-vec.ts:57-71` | Returns `{ ok: false, error }` rather than throwing when the extension is absent. |
| 9 | `src/logging/config.ts:36`, `src/config/gateway-env-selection.ts:5,21` | `ANDROID_DATA` and `PREFIX` are already in the config/env cache-key selectors. |
| 10 | `ui/index.html`, `ui/src/styles/base.css` | Already mobile-first: `viewport-fit=cover`, `interactive-widget=resizes-content`, `manifest.webmanifest`, `env(safe-area-inset-*)`, `100dvh`, `@media (pointer: coarse)`, breakpoints at 768/640/560 px, `display-mode: standalone`. |
| 11 | `src/cli/gateway-cli/register.ts:439` | `openclaw gateway run` — foreground Gateway. The only viable Termux entry point today. |
| 12 | `node:sqlite` via `node-sqlite.mjs` | Capability-probed, no native addon to compile. The single biggest reason this port is feasible. |

---

## 4. Findings

### Tier 0 — Install and boot fail outright

**T0.1 · `scripts/install.sh` misroutes Termux, then dies on `sudo`.**
`detect_os_or_die()` (line 447) tests `[[ "$OSTYPE" == "linux"* ]]`. Termux bash
sets `OSTYPE=linux-android`, so it matches and sets `OS="linux"`. The installer
then walks desktop package managers — `apt-get`/`pacman`/`dnf`/`yum`/`apk`
(lines 895-915, 2391-2434). Termux ships `pkg` and `apt`, not `apt-get`; every
probe misses, it falls through to `sudo`, and line 2489 aborts with *"sudo is
required for system installs on Linux"*. Separately `gum_detect_os()` (line 300)
has no Android case → `"unsupported"`.

**T0.2 · `scripts/install-cli.sh` installs a Node that cannot execute.**
`os_detect()` (line 485) maps `uname -s` → `Linux` → `"linux"`; `arch_detect()`
(496) → `arm64`. It then fetches the official `node-vXX-linux-arm64.tar.xz`.
That binary is glibc-linked; Android refuses to run it. `is_musl_linux()` (556)
checks `/etc/alpine-release` and `ldd --version | grep musl` — neither fires on
Termux, so there is **no refusal branch**. This is the worst failure mode in the
repo because it is reachable at runtime too: `openclaw.mjs` →
`recoverNodeRuntime({ allowInstall: true })` → `node-runtime-update.mjs` →
`scripts/install-cli.sh`. A phone that was working can be talked into
self-breaking on the next version bump.

**T0.3 · Node floor vs. what Termux actually ships.**
`package.json engines.node` = `>=24.16.0 <25 || >=26.1.0`;
`node-version.mjs NODE_RELEASE_FLOORS` = 24.16.0 / 26.1.0. Node.js publishes **no**
Android binaries — Termux builds `nodejs` and `nodejs-lts` itself against Bionic
and system ICU, and can lag the floor. When it lags, the printed remediation is
`nvm install 26`, which downloads glibc tarballs and fails the same way as T0.2.

**T0.4 · `@lydell/node-pty` is a hard dependency with no Android build.**
In `dependencies` (not optional) at `1.2.0-beta.15`. Its platform packages are
`darwin-arm64/x64`, `linux-arm64/x64`, `win32-arm64/x64` — **no android**.
Imported in exactly one production place: `src/process/terminal-pty.ts:134`
(`await import("@lydell/node-pty")`). Downstream: `src/gateway/terminal/session-manager.ts:9`,
`src/node-host/pty-command.ts:7`, `src/process/supervisor/adapters/pty.ts:28`.
Exec survives via finding #4 above; the Gateway web terminal and node `pty`
command do not. Building node-pty from source needs Bionic `forkpty`/`openpty`
work, so the realistic answer is a capability probe, not a build.

**T0.5 · `@openclaw/fs-safe` postinstall repair loop.**
Also a hard dependency; prebuilds cover darwin/linux(gnu+musl)/win32 only.
`scripts/lib/fs-safe-prebuild.mjs` (wired via `postinstall`) calls
`configureFsSafeNative({ mode: "require" })`, probes, and on
`Cannot find module '@openclaw/fs-safe-<variant>'` runs an **npm install** to
repair. On Termux the only candidate is a glibc/musl build that can never load →
slow installs, wasted network, and a postinstall that can fail `npm i -g openclaw`
outright. Fix: detect Android, skip repair, pin `FS_SAFE_NATIVE_MODE=off`.

### Tier 1 — It runs, but silently takes the wrong branch

**T1.1 · Zero host-platform Android checks.**
Non-test production counts: `process.platform ===/!== "linux"` **112**,
`"darwin"` **103**, `"win32"` **516**, host-level `"android"` **2**
(findings #2 and #3). Every other `"android"` in `src/` refers to the *Android
companion app connecting as a node* — `node-command-policy.ts:192`,
`connect-device-metadata.ts:40,213`, `manifest-platforms.ts:6` — never to "the
machine I am running on". That conceptual gap is the root cause. Concrete damage:

- `src/commands/doctor-platform-notes.ts:230-243` `noteStartupOptimizationHints()`
  gates the low-power-host advice (`NODE_COMPILE_CACHE`, `OPENCLAW_NO_RESPAWN=1`)
  on `platform === "linux" && (isArmHost || isLowMemoryLinux)`. **The one platform
  that needs this advice most is the one platform that never receives it.**
- `src/commands/doctor-gateway-services.ts:123`, `doctor-gateway-dueling.ts:24`,
  `doctor-gateway-installation.ts:217` — all Linux service diagnostics skipped, so
  `openclaw doctor` reports healthy while nothing is supervised.
- `src/agents/sandbox/docker-mount-source.ts:86,179` — mount-source logic silently
  disabled by `process.platform !== "linux"`.
- `extensions/browser/src/browser/chrome.executables.ts:143-151` —
  `detectDefaultChromiumExecutable()` returns `null`; browser tools vanish without
  a reason.

**T1.2 · No service manager, no wake lock, no autostart.**
`src/daemon/service.ts:181` declares `SupportedGatewayServicePlatform = "darwin" | "linux" | "win32"`
with three complete adapters (~40 `launchd*` files, ~45 `systemd*`, ~35 `schtasks*`).
Termux has none. `describeUnsupportedGatewayService()` (line 184) already
special-cases FreeBSD with actionable text — Android falls to the generic
`"Gateway service install not supported on android"`. Today the only path is
`openclaw gateway run` in a foreground Termux session, with no
`termux-wake-lock`, so Android kills it on doze.

**T1.3 · Memory and concurrency sized for servers.**

- `src/daemon/gateway-heap.ts`: floor `2048` MiB, cap `max(8192, totalmem/4)`,
  headroom `totalmem * 0.75`. On Android `os.totalmem()` returns *device* RAM
  (6-12 GB typical), so V8 gets `--max-old-space-size=4096`. `process.constrainedMemory()`
  is not meaningful there. Android's LMK kills it first, and there is no swap.
- `src/config/agent-limits.ts:14-19`: `max(8, availableParallelism * 4)` → **32
  concurrent agent runs** on an octa-core phone that is also running the OS and a
  browser. big.LITTLE means those 8 "cores" are not equal.
- `src/infra/worker-task-pool-core.ts:120`: `maxWorkers = availableParallelism()`
  → 8 V8 isolates.
- `src/node-host/node-worker-capacity.ts:62`: same shape.
- `src/infra/sqlite-worker-broker.ts:65`: `min(8, max(2, parallelism/8))` → 2. Fine.

**T1.4 · `/bin/sh` does not exist.**
Termux has no `/bin`; shells live at `$PREFIX/bin/{sh,bash}`.
`src/agents/shell-utils.ts:241` (`fs.existsSync("/bin/bash")`) fails but recovers
through `resolveShellFromPath("bash")` → PATH lookup. **`src/agents/github-exec-launch.ts:38`
hardcodes `["/bin/sh", "-c", ...]` → ENOENT.** `chrome.executables.ts:552-571`
probes `/usr/bin/*` and `/snap/bin/*`, all absent.

**T1.5 · No Termux API integration.**
Zero references to `termux-wake-lock`, `termux-notification`, `termux-open-url`,
`termux-clipboard-set`, `termux-battery-status`, `termux-vibrate`, `termux-tts-speak`
in `src/` or `*.mjs`. Only the SSH-widget shell scripts use them.
`src/infra/clipboard.ts:20-22` offers `pbcopy`/`xclip`/`wl-copy` only;
`browser-open.ts:67-87` offers `xdg-open`/`wslview` only. So `openclaw dashboard`
prints a URL instead of opening the phone's browser.

### Tier 2 — Degraded features that fail quietly

| Feature | Where | Status on Termux |
| --- | --- | --- |
| Vector / semantic memory | `packages/memory-host-sdk/src/host/sqlite-vec-platform-variant.ts` `PLATFORM_VARIANTS` | No `android-arm64` → returns `undefined` → index off. Buildable from source with clang. |
| Browser automation | `extensions/browser/src/browser/chrome.executables.ts` | No Chromium. **But Android has Chrome** — a CDP bridge to `localhost:9222` is an opportunity, not just a loss. |
| Sandboxing | `src/agents/sandbox/*` | Docker/Podman impossible without root. Must say "unavailable on this host", not "misconfigured". |
| `memory-lancedb` plugin | `@lancedb/lancedb` declares `os: [darwin, linux, win32]` | npm `EBADPLATFORM`. Excluded from published `dist/`, so core install is safe; ClawHub install fails confusingly. |
| `onnx` plugin | `onnxruntime-node` declares `os: [win32, darwin, linux]` | Same. |
| Gateway web terminal | `src/gateway/terminal/session-manager.ts` | Dies with T0.4. Needs an explicit "PTY unavailable" surface. |
| `koffi`-based FS ops | `src/agents/worktrees/filesystem-apfs.native.ts` (loads `/usr/lib/libSystem.B.dylib`), `filesystem-refs.native.ts` (loads `kernel32.dll`) | `@koromix/koffi-android-arm64` **does** exist, so these must stay strictly platform-gated — an Android koffi success could tempt a wrong-library load. |

### Tier 3 — Mobile UX

- Control UI is responsive but **unreachable**: default bind is loopback
  (`src/gateway/control-ui-links.ts:42` → `127.0.0.1`, correct for a phone) yet
  nothing opens it (T1.5).
- PWA manifest exists → "Add to Home screen" yields a fullscreen app shell.
  Unverified against a loopback origin + service worker.
- TUI (`src/tui`, `@earendil-works/pi-tui`) at phone width with a soft keyboard:
  no hardware Esc/Ctrl/arrows. `@clack/prompts` flows are painful without
  Termux's extra-keys row.
- Battery: heartbeat + cron + channel polling keep the radio up. No "phone profile".
- Disk: `src/infra/disk-space.ts` 1 GB low-space threshold is not phone-realistic.

---

## 5. The plan

Five phases. Phase 0 and 1 are the port; 2 and 3 make it survivable and native;
4 makes it pleasant and keeps it that way.

**Idiomatic precedent: FreeBSD.** It is an installer-unsupported platform that
got a first-class lane — `describeUnsupportedGatewayService()` branch,
`src/infra/update-freebsd-pkg-ownership.ts`, FreeBSD cases in
`exec-authorization-plan.ts:131`, `dispatch-wrapper-resolution.ts:285`,
`package-update-swap.ts` (6 sites), `update-global.ts` (2 sites), plus
`scripts/freebsd-service-inspect.mjs` and `scripts/lib/freebsd-service-discovery.mjs`
shipped in `package.json files`. Termux should follow that exact shape rather
than inventing a new mechanism.

### Phase 0 — Make it install and boot (blocking, ~3-5 days)

| ID | Work | Files |
| --- | --- | --- |
| 0.1 | Add `isTermux()` / `isAndroidHost()` detection, modelled on `src/infra/wsl.ts` (`isWSLEnv` → `isWSLSync` → cached async `isWSL`, plus a test reset). Env signals: `process.platform === "android"`, `PREFIX` matching `com.termux/files/usr`, `ANDROID_DATA`. Export from one owner; do **not** scatter re-implementations. | new `src/infra/termux.ts` + `src/infra/termux.test.ts` |
| 0.2 | Refuse the broken Node download. In `os_detect()` return a distinct `android` value and `fail` with Termux-specific remediation (`pkg upgrade && pkg install nodejs-lts`). Add an `is_termux()` guard alongside `is_musl_linux()` so the refusal is explicit, not a mystery linker error. | `scripts/install-cli.sh:485,496,556,1834-1859` |
| 0.3 | Same guard on the runtime recovery path so a working phone cannot be talked into self-breaking. | `node-runtime-update.mjs:7-17`, `node-runtime-recovery.mjs`, `openclaw.mjs:ensureSupportedRuntimeVersion` |
| 0.4 | Termux-specific unsupported-Node message: replace the `nvm install 26` advice with `pkg upgrade nodejs-lts` when `isTermux()`. | `node-version.mjs:formatUnsupportedNodeVersionMessage` |
| 0.5 | Teach `install.sh` about Termux: add `Linux`+`$OSTYPE == linux-android` / `$PREFIX` detection in `detect_os_or_die()` and `gum_detect_os()`; add a `pkg`-based branch that installs `nodejs-lts git ripgrep fd` with **no `sudo`**; skip the desktop build-tools block. | `scripts/install.sh:300,447,895-915,2391-2434,2489` |
| 0.6 | Make `node-pty` optional at the single import site: probe capability once, cache it, and surface a typed "PTY unavailable" result instead of letting `ERR_MODULE_NOT_FOUND` escape. Then give the three consumers a real message. | `src/process/terminal-pty.ts:134`, `src/gateway/terminal/session-manager.ts`, `src/node-host/pty-command.ts`, `src/process/supervisor/adapters/pty.ts` |
| 0.7 | Short-circuit the fs-safe native repair on Android and pin `FS_SAFE_NATIVE_MODE=off` so the portable fallback is deliberate rather than accidental. | `scripts/lib/fs-safe-prebuild.mjs`, `scripts/postinstall-bundled-plugins.mjs` |
| 0.8 | Fix the hardcoded `/bin/sh`. | `src/agents/github-exec-launch.ts:38` |

**Exit criteria:** on a real phone, `pkg install nodejs-lts git` then
`curl … install.sh | bash` completes; `openclaw --version`, `openclaw doctor`,
`openclaw onboard`, and `openclaw gateway run` all work; nothing attempts a
glibc download.

### Phase 1 — Make the platform truth explicit (~4-6 days)

| ID | Work | Files |
| --- | --- | --- |
| 1.1 | Introduce one host-platform vocabulary (`isLinuxLike()`, `isAndroidHost()`, `hostServiceKind()`) and migrate the 112 `linux` sites **only where behaviour actually differs**. Do not blanket-replace — most `!== "linux"` checks are Windows/macOS guards where Android correctly behaves as "other". Audit each site and record the decision. | `src/infra/termux.ts` as owner |
| 1.2 | Unlock the low-power tuning hints for Android — this is the highest-value single line in the phase. Phones are exactly the `isArmHost \|\| isLowMemory` target. | `src/commands/doctor-platform-notes.ts:230-243` |
| 1.3 | Add an Android branch to `describeUnsupportedGatewayService()` with real instructions (Termux:Boot / `termux-services` / foreground `gateway run`), matching the FreeBSD precedent. | `src/daemon/service.ts:181-200` |
| 1.4 | Make Doctor report Android honestly: a "Termux host" platform note listing what is unavailable and why (no sandbox, no PTY, no vector index, no browser) instead of silent absence. | `src/commands/doctor-platform-notes.ts`, `doctor-gateway-services.ts:123` |
| 1.5 | Replace `/bin/*` and `/usr/*` assumptions with `$PREFIX`-aware resolution. | `src/agents/shell-utils.ts`, `extensions/browser/src/browser/chrome.executables.ts:552-571` |
| 1.6 | Sandbox must say "unavailable on this host" rather than "misconfigured". | `src/agents/sandbox/backend.ts`, `container-engine.ts` |

**Exit criteria:** `openclaw doctor` on a phone produces a truthful report; no
production code path silently assumes glibc, `/bin`, or a service manager.

### Phase 2 — Survive Android: resources and lifecycle (~4-6 days)

| ID | Work | Files |
| --- | --- | --- |
| 2.1 | Android heap profile. `os.totalmem()` on a phone is device RAM, not usable budget. Cap the old-space floor well below 2048 MiB when `isAndroidHost()`, and prefer a configurable `OPENCLAW_GATEWAY_HEAP_MIB` escape hatch. | `src/daemon/gateway-heap.ts:11-13,55-81` |
| 2.2 | Android concurrency profile. `availableParallelism()` on big.LITTLE overstates capacity. Cap agent concurrency and worker-pool size on Android, honouring existing config overrides. | `src/config/agent-limits.ts:14-19`, `src/infra/worker-task-pool-core.ts:120`, `src/node-host/node-worker-capacity.ts:62` |
| 2.3 | **Wake lock.** Acquire `termux-wake-lock` on Gateway start and release on clean shutdown; report state in `gateway status`. Without this, Doze kills the Gateway every time the screen turns off — it is the difference between a toy and an always-on assistant. | new `src/daemon/termux-wakelock.ts`, wired into `src/cli/gateway-cli/run-loop.ts` |
| 2.4 | **Termux service adapter.** Register a fourth `GatewayService` implementing `termux-services` (`sv up/down/status` against `$PREFIX/var/service/openclaw`) with a `nohup`/`setsid` fallback. Add `android` to `SupportedGatewayServicePlatform`. | `src/daemon/service.ts:181,225`, new `src/daemon/termux-service.ts` |
| 2.5 | **Termux:Boot autostart.** Emit `~/.termux/boot/start-openclaw.sh` from `openclaw gateway install`, including the wake-lock call. | same adapter |
| 2.6 | Ship an `openclaw-termux-profile` config preset: reduced concurrency, tighter log retention, disabled browser/sandbox/vector, conservative heartbeat. One command to adopt. | `src/config/` + new preset |
| 2.7 | Realistic disk thresholds for `/data`. | `src/infra/disk-space.ts:5` |

**Exit criteria:** Gateway survives 24 h with the screen off; survives an
Android app-kill and restarts on boot; `openclaw gateway status` reports the
supervisor and wake-lock truthfully.

### Phase 3 — Feel native: Termux API integration (~3-4 days)

One owner module (`src/infra/termux-api.ts`) that probes `termux-api`
availability once, then typed wrappers. Every wrapper degrades to a no-op with a
reason, never a throw.

| ID | Capability | Replaces / improves |
| --- | --- | --- |
| 3.1 | `termux-open-url` | `src/infra/browser-open.ts:87` — makes `openclaw dashboard` actually open the Control UI |
| 3.2 | `termux-clipboard-set` / `-get` | `src/infra/clipboard.ts:20-22` |
| 3.3 | `termux-notification` | A local notification channel — the assistant can reach the user with **no** external chat channel configured. Highest-value UX win on a phone. |
| 3.4 | `termux-vibrate` | Approval/attention haptics |
| 3.5 | `termux-battery-status` | Feed into 2.2/2.6: throttle heartbeat and cron when on battery and low |
| 3.6 | `termux-tts-speak` | Spoken replies without a cloud TTS provider |
| 3.7 | `termux-wake-lock` / `-wake-unlock` | Used by 2.3 |
| 3.8 | `termux-share` / `termux-open` | Send generated files to any Android app |
| 3.9 | Extend `TERMUX_PACKAGES` beyond `fd`/`rg` to the tools OpenClaw actually shells out to (`ffmpeg`, `imagemagick`, `git`, `jq`, `ripgrep`, `fzf`) | `src/agents/utils/tools-manager.ts:358` |
| 3.10 | **Opportunity:** CDP bridge to the phone's real Chrome on `localhost:9222`, so browser tools work by driving the Chrome the user already has | `extensions/browser/src/browser/chrome.executables.ts:143-151` |

### Phase 4 — Docs, packaging, and a regression net (~3-4 days)

| ID | Work | Files |
| --- | --- | --- |
| 4.1 | `docs/install/termux.md`, modelled on `docs/install/raspberry-pi.md` (hardware table, prerequisites, steps, troubleshooting). Register in the `docs.json` nav next to `install/raspberry-pi`. | new doc + `docs/docs.json:1441` |
| 4.2 | Correct `docs/platforms/android.md`, which currently states flatly: *"Role: companion node app (Android does not host the Gateway)"* (line 17) and *"Gateway required: yes"* (line 18). Add a Termux-hosting section and cross-link the companion-app path. | `docs/platforms/android.md:12-18` |
| 4.3 | Document `FS_SAFE_NATIVE_MODE=off`, the heap/concurrency overrides, Termux extra-keys for the TUI, and `termux-api` install. | `docs/help/environment.md:54`, new termux doc |
| 4.4 | Repoint the three SSH-widget scripts at the local Gateway when one is running, so they work in both topologies. | `scripts/termux-*.sh` |
| 4.5 | **CI.** Add a Termux lane. A real Android emulator is heavy; start with a static gate — a lint/test that fails if new production code adds a bare `process.platform === "linux"` without an Android decision, mirroring the existing `src/infra/fs-safe-import-boundary.test.ts` pattern. | new `test/` + `.github/workflows/` |
| 4.6 | Device matrix + manual test script covering: install, onboard, gateway run, Control UI in Chrome, PWA add-to-home, channel round-trip, exec tool, doze survival, reboot autostart, low-battery throttle. | new `scripts/test-termux-manual.sh` |
| 4.7 | Optional: publish `android-arm64` builds for `sqlite-vec` and `@openclaw/fs-safe` (both are buildable with Termux clang), restoring vector memory and native FS ops. | upstream packages |

---

## 6. Verification strategy

No Android device exists in this workspace, so I could not execute the failure
paths. What I did instead, and what I recommend:

**Already done here (static, high confidence):**
- Traced every install and boot entry point (`openclaw.mjs` → `node-runtime-recovery.mjs`
  → `node-runtime-update.mjs` → `scripts/install-cli.sh`) and read the actual
  branch conditions.
- Enumerated all 277 `os:`-restricted packages in `pnpm-lock.yaml` and classified
  the 17 distinct native-addon families by Android availability. Only 7 ship an
  `android-arm64` build: `@koromix/koffi`, `@oxfmt/binding`, `@oxlint/binding`,
  `@rolldown/binding`, `@snazzah/davey`, `@yuku-codegen/binding`, and
  `@yuku-parser/binding`. `@esbuild/*` additionally publishes `android-arm`,
  `android-arm64`, and `android-x64`. The 10 that do **not**:
  `@anthropic-ai/claude-agent-sdk`, `@github/copilot-sdk`, `@lancedb/lancedb`,
  `@lydell/node-pty`, `@openai/codex`, `@openclaw/fs-safe`, `@tloncorp/tlon-skill`,
  `@trycua/cua-driver`, `@typescript/typescript`, `@ubjs/node`.
- Unpacked `@openclaw/fs-safe@0.21.1` from npm to confirm the portable fallback
  and the `FS_SAFE_NATIVE_MODE` escape hatch exist rather than assuming them.
- Counted host-platform checks: 112 linux / 103 darwin / 516 win32 / 2 android.
- Confirmed the Android facts against upstream reports (`process.platform === "android"`,
  kernel rejection of glibc ELF, `$OSTYPE=linux-android`).

**Still required before claiming "runs smoothly":**
1. A physical device or emulator on Termux with `nodejs-lts` — record
   `node -v`, `node -p "process.platform + ' ' + process.arch"`,
   `node -e "require('node:sqlite')"`, `echo $OSTYPE`, `termux-info`.
2. Run the Phase 0 exit criteria end to end and capture output.
3. A 24-hour doze survival test (Phase 2 exit criteria) — this cannot be
   shortened or simulated meaningfully.
4. Add `node -p "process.report.getReport().header.glibcVersionRuntime"` to the
   device matrix: it is the exact probe `canInstallPrivateNode()` relies on, and
   confirming it is `undefined` on Termux validates T0.3's reasoning on hardware.

I can build a `scripts/termux-audit.sh` that collects all of the above into one
pasteable report, so a first device run produces evidence instead of guesses.

---

## 7. Suggested sequencing

| Order | Phase | Why here | Effort |
| --- | --- | --- | --- |
| 1 | Phase 0 | Nothing else is testable until install and boot work | 3-5 d |
| 2 | Phase 2.1-2.3 | Heap, concurrency, and wake lock — without these the Gateway dies within minutes and every later test is noise | 2 d |
| 3 | Phase 1 | Correctness and honest diagnostics | 4-6 d |
| 4 | Phase 2.4-2.6 | Supervision and autostart | 3 d |
| 5 | Phase 4.1-4.3, 4.6 | Docs and the manual test script, so real users can reproduce | 2 d |
| 6 | Phase 3 | Native feel — the payoff phase | 3-4 d |
| 7 | Phase 4.5, 4.7 | CI gate and optional native rebuilds | 3 d |

Total: roughly **22-28 engineering days** for a properly supported Termux host.
A "boots and is usable, foreground only" milestone is achievable in **~7 days**
(Phase 0 + 2.1-2.3).

---

## 8. The other topology (phone as client, not host)

If the real goal is *controlling a desktop Gateway from a phone*, most of the
above is unnecessary and the work is much smaller:

- The existing `scripts/termux-*.sh` widgets already do this over SSH; they need
  the maintainer-specific hostnames generalised (partly done per
  `docs/releases/2026.6.11.md:426`).
- `ui/` is already a mobile-first PWA — point a phone browser at the Gateway's
  Control UI and add to home screen.
- `apps/android` is a full native companion node (Kotlin/Compose, Room, CDP
  bridge, voice) and is the better answer for this topology.
- Remaining gaps: Tailscale/loopback documentation, and a Termux-side
  `openclaw` CLI shim that talks to a remote Gateway rather than starting one.

Worth confirming which topology you want before Phase 0 starts, because it
changes the plan substantially. My reading of your request is host-on-phone, and
that is what Sections 4-7 plan for.

---

## 9. Explicitly out of scope

- Running Docker, Podman, or any container sandbox natively in Termux (needs root).
- `proot-distro` as a hosting strategy — it turns the phone into a slow emulated
  Linux box and defeats the point of a native port. Reasonable as a *user-side*
  workaround to document, not as a supported path.
- Building Chromium, ONNX Runtime, or LanceDB for Bionic.
- Changing the Android companion app (`apps/android`), which is a separate,
  already-working surface.
- Lowering the Node floor globally to accommodate Termux — the floor exists for a
  real `node:sqlite` TEXT/BLOB correctness reason (`node-version.mjs` comments,
  `node-sqlite.mjs` capability probe). Termux should meet the floor via
  `pkg upgrade`, not have the floor moved.
