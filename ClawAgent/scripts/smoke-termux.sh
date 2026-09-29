#!/usr/bin/env bash
# ClawAgent smoke test.
#
# Runs on a Termux checkout with nothing installed but Node — no node_modules,
# no pnpm, no vitest. That constraint is the point: this is the check a person
# can run on the phone they are debugging with, and it is the gate every
# milestone must keep passing before it is allowed to claim it works on Android.
#
# It is deliberately not `set -e`. A smoke test that stops at the first failure
# tells you one thing when you could have learned five, and on a device you may
# not get a second run cheaply. Failures accumulate and are all reported.
#
# Usage:
#   bash scripts/smoke-termux.sh            # full run
#   bash scripts/smoke-termux.sh --quiet    # only the summary and failures
#
# Exit codes: 0 = everything passed, 1 = one or more checks failed.

set -uo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PACKAGE_ROOT/.." && pwd)"
BIN="$PACKAGE_ROOT/bin/clawagent.mjs"
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    -h | --help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "smoke-termux.sh: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

PASSED=0
FAILED=0
FAILED_NAMES=()
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clawagent-smoke.XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

ok() {
  PASSED=$((PASSED + 1))
  [ "$QUIET" -eq 1 ] || printf '  ok   %s\n' "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  FAILED_NAMES+=("$1")
  printf '  FAIL %s\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '%s\n' "$2" | sed 's/^/         /'
  fi
}

# check <name> <expected-exit> <command...>
check() {
  local name="$1"
  local expected="$2"
  shift 2
  local output
  output="$("$@" 2>&1)"
  local status=$?
  if [ "$status" -eq "$expected" ]; then
    ok "$name"
  else
    fail "$name (expected exit $expected, got $status)" "$output"
  fi
}

section() { [ "$QUIET" -eq 1 ] || printf '\n%s\n' "$1"; }

echo "ClawAgent smoke test"
echo "  package  $PACKAGE_ROOT"
echo "  workdir  $WORK_DIR"

# ---------------------------------------------------------------- environment
section "environment"

if [ -n "${ANDROID_DATA:-}" ] && [ -n "${PREFIX:-}" ]; then
  echo "  host     Termux (PREFIX=$PREFIX)"
  ON_TERMUX=1
else
  echo "  host     not Termux — device-specific checks are skipped"
  ON_TERMUX=0
fi

if ! command -v node >/dev/null 2>&1; then
  fail "node is installed" "$(echo "node not found on PATH; on Termux: pkg install nodejs-lts")"
  echo
  echo "smoke test aborted: no node"
  exit 1
fi
ok "node is installed ($(node -v))"

# Type stripping is what lets ClawAgent run from source with no build step.
STRIPPING="$(node -e 'process.stdout.write(String(process.features?.typescript ?? ""))' 2>/dev/null)"
if [ -n "$STRIPPING" ]; then
  ok "node type stripping available ($STRIPPING)"
else
  fail "node type stripping available" \
    "process.features.typescript is empty; ClawAgent cannot run from source on this Node.
On Termux: pkg update && pkg install nodejs-lts"
fi

if [ ! -f "$BIN" ]; then
  fail "entry point exists" "missing $BIN"
  echo
  echo "smoke test aborted: no entry point"
  exit 1
fi
ok "entry point exists"

# ---------------------------------------------------------------------- node
# Flags every check that loads TypeScript source needs. Kept unquoted on
# purpose: it is a word-split flag list, and `node --flag` accepts no other
# shape. transform-types because two reused cores (`ai`, `retry`) use
# TypeScript parameter properties, which strip-only mode rejects outright.
NODE_FLAGS="--experimental-transform-types --disable-warning=ExperimentalWarning"

# ------------------------------------------------------- runtime dependencies
# Since M1 the shared cores are loaded from source, and they import npm packages
# (`@openclaw/llm-core` imports `typebox` unconditionally). Without them every
# later check fails with a module-not-found error that blames the wrong thing, so
# this is settled once, up front, with the command that fixes it.
section "runtime dependencies"

# Two traps this avoids, both of which produced a wrong answer here once:
#
# * The list of names is computed from the dependency ledger instead of being
#   written out again. The copy in this file went stale the moment a load-path
#   dependency was added, and a smoke test that checks for eight packages when
#   thirteen are needed reports success on a broken device.
# * Resolution is rooted at ClawAgent/, not at the repository root, and falls
#   back to the same resolver the entry point installs. A phone follows the
#   README and installs *inside* ClawAgent/, so probing from the repo root
#   reports a correct install as broken — and then every dependent section
#   skips itself, which looks like a pass.
DEP_PROBE="$(
  # shellcheck disable=SC2086
  node $NODE_FLAGS --input-type=module -e "
    const packageRoot = '$PACKAGE_ROOT';
    const packagesDir = '$REPO_ROOT/packages';
    const { existsSync } = await import('node:fs');
    const { pathToFileURL } = await import('node:url');
    const { createRequire } = await import('node:module');
    if (!existsSync(pathToFileURL(packagesDir + '/normalization-core/package.json').pathname)) {
      process.stdout.write('skip');
      process.exit(0);
    }
    const ledgerUrl = pathToFileURL(packageRoot + '/src/runtime/reused-packages.ts').href;
    const resolverUrl = pathToFileURL(packageRoot + '/src/runtime/source-resolution.ts').href;
    const { collectRequiredExternalDependencies } = await import(ledgerUrl);
    const { resolveRuntimeDependency } = await import(resolverUrl);
    const required = Object.keys(
      collectRequiredExternalDependencies(packagesDir).required,
    ).sort();
    const requireFromPackage = createRequire(pathToFileURL(packageRoot + '/package.json'));
    const missing = required.filter((name) => {
      try {
        requireFromPackage.resolve(name);
        return false;
      } catch {
        // Normal resolution lost: the runtime fallback gets the same chance a
        // real import would, and only then is the package called missing.
        return resolveRuntimeDependency(name, packageRoot) === undefined;
      }
    });
    process.stdout.write(missing.length
      ? 'missing:' + missing.join(' ')
      : 'ok:' + required.length);
  " 2>/dev/null
)"

DEPS_MISSING=""
case "$DEP_PROBE" in
  skip)
    ok "skipped: no packages/ checkout beside the package to compute the list from"
    ;;
  missing:*)
    DEPS_MISSING="${DEP_PROBE#missing:}"
    fail "every external dependency the reused cores need is installed" \
      "missing: $DEPS_MISSING
run: cd $PACKAGE_ROOT && npm install --omit=dev
(the later checks load the shared cores from source, which import these)"
    ;;
  ok:*)
    ok "all ${DEP_PROBE#ok:} external dependencies the reused cores need are installed"
    ;;
  *)
    DEPS_MISSING="unknown"
    fail "every external dependency the reused cores need is installed" \
      "the check itself failed to run, which is itself the result: it loads
src/runtime/reused-packages.ts and src/runtime/source-resolution.ts, and a
module that cannot load cannot run on this device either."
    ;;
esac

# ------------------------------------------------------------------ the whole
# Every production module must load on its own. This is the substitute for a
# typecheck on a device: it proves each file survives type stripping and that
# every specifier actually resolves, which is the failure mode the
# `.js`-vs-`.ts` decision exists to prevent.
#
# Since M1 the modules import the shared `@openclaw/*` cores, so each one is
# loaded through the same resolve hook the entry point installs. Loading them
# without it would test a configuration that never occurs, and would pass for a
# hook that is broken.
section "modules load"

# runtimeDependenciesDir is not decoration: bare npm imports made from inside
# packages/*/src resolve upward from the *importing file*, so on a phone that
# followed the README and installed inside ClawAgent/ they would find nothing
# and every module below would fail with a module-not-found error. Passing it
# makes this loader match the entry point, and exercises the fallback itself.
load_with_hooks() {
  # shellcheck disable=SC2086  # NODE_FLAGS is a deliberate word-split flag list
  node $NODE_FLAGS --input-type=module -e "
    const { installSourceResolutionHooks } = await import('file://$PACKAGE_ROOT/src/runtime/source-resolution.ts');
    const hooks = installSourceResolutionHooks({
      packagesDir: '$REPO_ROOT/packages',
      runtimeDependenciesDir: '$PACKAGE_ROOT',
    });
    if (!hooks.installed) {
      console.error('resolve hook not installed: ' + hooks.reason);
      process.exit(1);
    }
    await import('file://$1');
  " 2>&1
}

if [ ! -d "$REPO_ROOT/packages" ]; then
  # An installed ClawAgent with no checkout beside it resolves `@openclaw/*` from
  # node_modules instead. That is a different, legitimate arrangement.
  ok "skipped: no packages/ checkout beside the package"
elif [ -n "$DEPS_MISSING" ]; then
  ok "skipped: runtime dependencies missing (reported above)"
else
  MODULE_FAILURES=0
  while IFS= read -r module; do
    rel="${module#"$PACKAGE_ROOT"/}"
    case "$rel" in
      *.test.ts | test/*) continue ;;
    esac
    if out="$(load_with_hooks "$module")"; then
      ok "$rel"
    else
      fail "$rel failed to load" "$out"
      MODULE_FAILURES=$((MODULE_FAILURES + 1))
    fi
  done < <(find "$PACKAGE_ROOT/src" "$PACKAGE_ROOT/bin" -type f \( -name '*.ts' -o -name '*.mjs' \) | sort)

  if [ "$MODULE_FAILURES" -eq 0 ]; then
    # The loop above covers src/index.ts too, so this is the summary, not another
    # load: a second bare `node` import would run without the hook and prove
    # nothing about the configuration a device actually uses.
    ok "every production module loads through the resolve hook"
  fi
fi

# ------------------------------------------------------------------------- cli
section "cli"

check "clawagent --version exits 0" 0 node "$BIN" --version
check "clawagent version exits 0" 0 node "$BIN" version
check "clawagent --help exits 0" 0 node "$BIN" --help
check "clawagent help doctor exits 0" 0 node "$BIN" help doctor

VERSION_OUT="$(node "$BIN" --version 2>&1)"
case "$VERSION_OUT" in
  *"clawagent "*) ok "--version reports a version" ;;
  *) fail "--version reports a version" "$VERSION_OUT" ;;
esac
case "$VERSION_OUT" in
  *0.0.0-unknown*)
    fail "--version reads package.json" "got the fallback: $VERSION_OUT"
    ;;
  *) ok "--version reads package.json (not the fallback)" ;;
esac

HELP_OUT="$(node "$BIN" --help 2>&1)"
for command in chat doctor version help; do
  case "$HELP_OUT" in
    *"$command"*) ok "help lists '$command'" ;;
    *) fail "help lists '$command'" "$HELP_OUT" ;;
  esac
done

# Exit codes are part of the contract: 0 healthy, 1 unhealthy, 2 usage error.
check "unknown command exits 2" 2 node "$BIN" definitely-not-a-command
check "unknown flag exits 2" 2 node "$BIN" doctor --definitely-not-a-flag
check "--log-level without a value exits 2" 2 node "$BIN" doctor --log-level

SUGGESTION="$(node "$BIN" doctr 2>&1)"
case "$SUGGESTION" in
  *"did you mean \"doctor\""*) ok "typo suggests the nearest command" ;;
  *) fail "typo suggests the nearest command" "$SUGGESTION" ;;
esac

# ---------------------------------------------------------------------- doctor
section "doctor"

STATE_DIR="$WORK_DIR/state-root"
DOCTOR_OUT="$(node "$BIN" doctor --skip-battery --home "$STATE_DIR" 2>/dev/null)"
DOCTOR_STATUS=$?

# doctor exits 1 when this device cannot run the host, which is a legitimate
# result rather than a crash. Anything else means the CLI itself broke.
if [ "$DOCTOR_STATUS" -eq 0 ] || [ "$DOCTOR_STATUS" -eq 1 ]; then
  ok "doctor exits 0 or 1 (got $DOCTOR_STATUS)"
else
  fail "doctor exits 0 or 1" "got $DOCTOR_STATUS:
$DOCTOR_OUT"
fi

for needle in "ClawAgent doctor" "Node runtime" "Free storage" "Writable state"; do
  case "$DOCTOR_OUT" in
    *"$needle"*) ok "doctor reports '$needle'" ;;
    *) fail "doctor reports '$needle'" "$DOCTOR_OUT" ;;
  esac
done

if [ -d "$STATE_DIR/state" ]; then
  ok "doctor honours --home and creates the state directory"
else
  fail "doctor honours --home and creates the state directory" "missing $STATE_DIR/state"
fi

if [ -f "$STATE_DIR/logs/clawagent.log" ]; then
  ok "doctor writes a log file"
  if grep -qm1 '^{"time":' "$STATE_DIR/logs/clawagent.log"; then
    ok "log file is JSON Lines"
  else
    fail "log file is JSON Lines" "$(head -n 2 "$STATE_DIR/logs/clawagent.log")"
  fi
else
  fail "doctor writes a log file" "missing $STATE_DIR/logs/clawagent.log"
fi

# Machine-readable output is what CI and later tooling consume.
JSON_OUT="$(node "$BIN" doctor --json --skip-battery --home "$WORK_DIR/json-root" 2>/dev/null)"
if printf '%s' "$JSON_OUT" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const report = JSON.parse(raw);
    const ids = report.capabilities.map((c) => c.id);
    const required = ["node.runtime", "node.sqlite", "state.home", "state.writable"];
    for (const id of required) {
      if (!ids.includes(id)) throw new Error("missing required capability: " + id);
    }
    if (typeof report.startable !== "boolean") throw new Error("startable is not a boolean");
    if (!report.paths || !report.paths.home) throw new Error("paths.home missing");
  });
' >/dev/null 2>&1; then
  ok "doctor --json is valid and complete"
else
  fail "doctor --json is valid and complete" "$(printf '%s\n' "$JSON_OUT" | sed -n '1,20p')"
fi

# stdout must stay machine-readable: warnings and log lines belong on stderr.
# Tested against the captured output rather than a pipe, because `head -c 1`
# closes the pipe early and `pipefail` would report the writer's SIGPIPE instead
# of the answer we actually asked for.
case "$JSON_OUT" in
  "{"*) ok "doctor --json keeps stdout parseable (warnings go to stderr)" ;;
  *) fail "doctor --json keeps stdout parseable" "stdout does not start with {" ;;
esac

# ------------------------------------------------------------------- respawn
section "respawn"

# M1 loads the shared cores from source, and two of them (`ai`, `retry`) contain
# TypeScript parameter properties. Strip-only mode rejects those outright, so the
# entry point re-executes itself with --experimental-transform-types. Without the
# flag, `clawagent chat` fails at import time with a syntax error that names a
# file the user has never heard of.
EXEC_ARGV="$(node "$BIN" version --json 2>/dev/null)"
case "$EXEC_ARGV" in
  *"--experimental-transform-types"*)
    ok "the entry point respawns with --experimental-transform-types"
    ;;
  *) fail "the entry point respawns with --experimental-transform-types" "$EXEC_ARGV" ;;
esac

# ---------------------------------------------------------------------- chat
section "chat"

# Every check below runs with no network and no valid credentials on purpose: a
# device that is out of data must still get a correct, actionable answer rather
# than a hang or a stack trace.
#
# The whole section is gated on the dependencies because it starts the real model
# runtime: without them every check would fail with a module-not-found error that
# points at the wrong thing, and a smoke test that reports eight symptoms of one
# missing `npm install` is a smoke test nobody reads.
if [ -n "$DEPS_MISSING" ]; then
  ok "skipped: chat needs the runtime dependencies (reported above)"
else
# Every check below runs with no network and no valid credentials on purpose: a
# device that is out of data must still get a correct, actionable answer rather
# than a hang or a stack trace.
  CHAT_HOME="$WORK_DIR/chat-home"
  mkdir -p "$CHAT_HOME"
# Obviously fake, and long enough that masking it is meaningful. Nothing below
# makes a request, so a dummy key is safe to hand to the real code path.
  CHAT_KEY="sk-ant-smoke-not-a-real-key-0000"

  check "help chat exits 0" 0 node "$BIN" help chat

  CHAT_HELP="$(node "$BIN" help chat 2>&1)"
  for flag in "--message" "--provider" "--base-url" "--show-thinking"; do
    case "$CHAT_HELP" in
      *"$flag"*) ok "chat help lists $flag" ;;
      *) fail "chat help lists $flag" "$CHAT_HELP" ;;
    esac
  done

  NO_MODEL="$(node "$BIN" chat -m hi --home "$CHAT_HOME" 2>&1)"
  status=$?
  if [ "$status" -eq 3 ]; then
    ok "chat with no model configured exits 3"
  else
    fail "chat with no model configured exits 3 (got $status)" "$NO_MODEL"
  fi
  case "$NO_MODEL" in
    *"no model id"*) ok "chat says the model id is missing" ;;
    *) fail "chat says the model id is missing" "$NO_MODEL" ;;
  esac
  case "$NO_MODEL" in
    *"CLAWAGENT_PROVIDER=anthropic"*) ok "chat offers a copyable one-liner" ;;
    *) fail "chat offers a copyable one-liner" "$NO_MODEL" ;;
  esac

  NO_KEY="$(env -u ANTHROPIC_API_KEY -u CLAWAGENT_API_KEY node "$BIN" chat -m hi \
    --provider anthropic --model claude-sonnet-4-5 --home "$CHAT_HOME" 2>&1)"
  status=$?
  if [ "$status" -eq 3 ]; then
    ok "chat with no API key exits 3"
  else
    fail "chat with no API key exits 3 (got $status)" "$NO_KEY"
  fi
  case "$NO_KEY" in
    *"no API key found"*) ok "chat names the missing key" ;;
    *) fail "chat names the missing key" "$NO_KEY" ;;
  esac
  case "$NO_KEY" in
    *"ANTHROPIC_API_KEY"*) ok "chat names the variable to set" ;;
    *) fail "chat names the variable to set" "$NO_KEY" ;;
  esac
  BAD_PROVIDER="$(CLAWAGENT_API_KEY=dummy node "$BIN" chat -m hi \
    --provider antropic --model x --home "$CHAT_HOME" 2>&1)"
  case "$BAD_PROVIDER" in
    *'did you mean "anthropic"'*) ok "a mistyped provider is corrected" ;;
    *) fail "a mistyped provider is corrected" "$BAD_PROVIDER" ;;
  esac

  check "chat -m with an empty message exits 2" 2 env CLAWAGENT_API_KEY=dummy \
    node "$BIN" chat -m "   " --provider anthropic --model x --home "$CHAT_HOME"

# Interactive mode over a pipe: stdin is not a TTY, which is how a Termux user
# runs this from a script or with input redirected. `/help` and `/model` need no
# network, so this exercises runtime startup end to end.
  PIPE_OUT="$(printf '/help\n/model\n/system\n/exit\n' | env \
    CLAWAGENT_API_KEY="$CHAT_KEY" node "$BIN" chat \
    --provider anthropic --model claude-sonnet-4-5 --home "$CHAT_HOME" 2>&1)"
  status=$?
  if [ "$status" -eq 0 ]; then
    ok "interactive chat over a pipe exits 0"
  else
    fail "interactive chat over a pipe exits 0 (got $status)" "$PIPE_OUT"
  fi
# Reaching the banner at all proves the shared runtime and its adapters loaded.
  case "$PIPE_OUT" in
    *"anthropic/claude-sonnet-4-5 via anthropic-messages"*)
      ok "the shared model runtime starts offline"
      ;;
    *) fail "the shared model runtime starts offline" "$PIPE_OUT" ;;
  esac
  case "$PIPE_OUT" in
    *"/clear"*) ok "/help lists the in-chat commands" ;;
    *) fail "/help lists the in-chat commands" "$PIPE_OUT" ;;
  esac
  case "$PIPE_OUT" in
    *"https://api.anthropic.com/v1"*) ok "/model reports the endpoint" ;;
    *) fail "/model reports the endpoint" "$PIPE_OUT" ;;
  esac
# The banner shows a masked key: enough to tell two keys apart, never enough to
# read one off a shared screen.
  case "$PIPE_OUT" in
    *"$CHAT_KEY"*) fail "the banner masks the API key" "$PIPE_OUT" ;;
    *"****"*) ok "the banner masks the API key" ;;
    *) fail "the banner masks the API key (no mask shown)" "$PIPE_OUT" ;;
  esac
  case "$PIPE_OUT" in
    *"You are ClawAgent"*) ok "/system shows the active prompt" ;;
    *) fail "/system shows the active prompt" "$PIPE_OUT" ;;
  esac
fi

# ---------------------------------------------------------------------- agent
section "agent"

# The usage errors are deliberately *outside* the dependency gate below: a bad
# flag is refused before the model runtime starts, so a device with nothing
# installed must still get exit 2 and an explanation rather than a module-not-found
# error that blames the install for the user's typo.
  check "help agent exits 0" 0 node "$BIN" help agent

  AGENT_HELP="$(node "$BIN" help agent 2>&1)"
  for flag in "--message" "--workspace" "--approve" "--yes" "--dry-run"; do
    case "$AGENT_HELP" in
      *"$flag"*) ok "agent help lists $flag" ;;
      *) fail "agent help lists $flag" "$AGENT_HELP" ;;
    esac
  done

AGENT_HOME="$WORK_DIR/agent-home"
  mkdir -p "$AGENT_HOME" "$WORK_DIR/agent-ws"

# An empty task is refused rather than sent to a provider, because a provider
# round trip on a phone costs money and data.
  EMPTY_TASK="$(node "$BIN" agent -m "   " --home "$AGENT_HOME" 2>&1)"
  status=$?
  if [ "$status" -eq 2 ]; then
    ok "agent with an empty task exits 2"
  else
    fail "agent with an empty task exits 2 (got $status)" "$EMPTY_TASK"
  fi
  case "$EMPTY_TASK" in
    *"non-empty message"*) ok "agent names the flag to fix" ;;
    *) fail "agent names the flag to fix" "$EMPTY_TASK" ;;
  esac

# An approval mode is a security decision, so a typo in one is never guessed at.
  BAD_MODE="$(node "$BIN" agent -m hi --approve auto --home "$AGENT_HOME" 2>&1)"
  status=$?
  if [ "$status" -eq 2 ]; then
    ok "an unknown approval mode exits 2"
  else
    fail "an unknown approval mode exits 2 (got $status)" "$BAD_MODE"
  fi
  case "$BAD_MODE" in
    *"unknown approval mode"*) ok "it names what it could not parse" ;;
    *) fail "it names what it could not parse" "$BAD_MODE" ;;
  esac
  case "$BAD_MODE" in
    *"read-only"*) ok "it lists the modes that do exist" ;;
    *) fail "it lists the modes that do exist" "$BAD_MODE" ;;
  esac

# `--yes` and `--approve` both move the same dial, and combining them silently
# picks a winner; refusing is the only answer that cannot loosen something the
# user meant to tighten.
  COMBINED="$(node "$BIN" agent -m hi --yes --approve read-only --home "$AGENT_HOME" 2>&1)"
  case "$COMBINED" in
    *"cannot be combined"*) ok "--yes and --approve are refused together" ;;
    *) fail "--yes and --approve are refused together" "$COMBINED" ;;
  esac

if [ -n "$DEPS_MISSING" ]; then
  ok "skipped: agent needs the runtime dependencies (reported above)"
else
# `--dry-run` prints the plan and calls nothing, so it is the one agent check that
# proves the whole startup path — config, provider resolution, tool construction,
# workspace canonicalisation — without a network, a key, or a model.
  AGENT_ENV="CLAWAGENT_PROVIDER=anthropic CLAWAGENT_MODEL=claude-sonnet-4-5 CLAWAGENT_API_KEY=sk-ant-smoke-not-a-real-key-0000"
  DRY_OUT="$(env $AGENT_ENV node "$BIN" agent --dry-run \
    --workspace "$WORK_DIR/agent-ws" --home "$AGENT_HOME" 2>&1)"
  status=$?
  if [ "$status" -eq 0 ]; then
    ok "agent --dry-run exits 0 offline"
  else
    fail "agent --dry-run exits 0 offline (got $status)" "$DRY_OUT"
  fi
  case "$DRY_OUT" in
    *"no model call was made"*) ok "--dry-run promises not to call the model" ;;
    *) fail "--dry-run promises not to call the model" "$DRY_OUT" ;;
  esac
# The workspace line is the canonicalised path, not the string that was typed: a
# device that resolves `/tmp` through a symlink has to be shown the real root, or
# the approval prompt that comes later will name a path the user never wrote.
  case "$DRY_OUT" in
    *"workspace: $WORK_DIR/agent-ws"*"paths"*) ok "--dry-run reports the resolved workspace" ;;
    *) fail "--dry-run reports the resolved workspace" "$DRY_OUT" ;;
  esac
  case "$DRY_OUT" in
    *"tools    : read, write, edit, glob, grep, bash"*) ok "--dry-run lists the tools a run would have" ;;
    *) fail "--dry-run lists the tools a run would have" "$DRY_OUT" ;;
  esac
# A read-only run must not merely refuse the mutating tools: it must not
# advertise them, or the model spends its turns calling things that cannot work.
  DRY_RO="$(env $AGENT_ENV node "$BIN" agent --dry-run --approve read-only \
    --workspace "$WORK_DIR/agent-ws" --home "$AGENT_HOME" 2>&1)"
  case "$DRY_RO" in
    *"tools    : read, glob, grep"*) ok "read-only mode drops the mutating tools" ;;
    *) fail "read-only mode drops the mutating tools" "$DRY_RO" ;;
  esac

# Interactive mode over a pipe. `agent` builds a prompter for both modes because
# the approval gate shares stdin, so this also proves the readline plumbing and
# the in-chat commands start up with no terminal and no network.
  AGENT_PIPE="$(printf '/tools\n/workspace\n/approve read-only\n/exit\n' | env $AGENT_ENV \
    node "$BIN" agent --workspace "$WORK_DIR/agent-ws" --home "$AGENT_HOME" 2>&1)"
  status=$?
  if [ "$status" -eq 0 ]; then
    ok "interactive agent over a pipe exits 0"
  else
    fail "interactive agent over a pipe exits 0 (got $status)" "$AGENT_PIPE"
  fi
  case "$AGENT_PIPE" in
    *"read, write, edit, glob, grep, bash"*) ok "/tools lists the live tool set" ;;
    *) fail "/tools lists the live tool set" "$AGENT_PIPE" ;;
  esac
  case "$AGENT_PIPE" in
    *"approval mode is now read-only"*) ok "/approve switches mode mid-session" ;;
    *) fail "/approve switches mode mid-session" "$AGENT_PIPE" ;;
  esac
  case "$AGENT_PIPE" in
    *"unknown command"*) fail "an unknown slash command is reported" "$AGENT_PIPE" ;;
    *) ok "the four known commands are accepted" ;;
  esac

# The tool layer, with no model in sight. This is the part of M2 that touches the
# device's filesystem, so it is checked directly: a real write, a real edit, a
# real read, an escape attempt, and a destructive command that must be refused in
# every approval mode including `full`.
  TOOLS_OUT="$(
    # shellcheck disable=SC2086
    node $NODE_FLAGS --input-type=module -e "
    const { installSourceResolutionHooks } = await import('file://$PACKAGE_ROOT/src/runtime/source-resolution.ts');
    installSourceResolutionHooks({
      packagesDir: '$REPO_ROOT/packages',
      runtimeDependenciesDir: '$PACKAGE_ROOT',
    });
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { buildWorkspaceTools } = await import('file://$PACKAGE_ROOT/src/tools/index.ts');
    const { decide } = await import('file://$PACKAGE_ROOT/src/approvals/policy.ts');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clawagent-tools-')));
    const built = buildWorkspaceTools({ root });
    const call = async (name, args) => {
      try {
        const result = await built.tools.find((tool) => tool.name === name).execute('smoke', args);
        return (result.content ?? []).map((part) => part.text ?? '').join('');
      } catch (error) {
        return 'THREW: ' + (error instanceof Error ? error.message : String(error));
      }
    };
    const problems = [];
    const expect = (label, condition, detail) => {
      if (!condition) problems.push(label + (detail ? ' -> ' + detail : ''));
    };
    await call('write', { path: 'src/sum.js', content: 'export function add(a, b) {\n  return a - b;\n}\n' });
    expect('write lands a file on disk', fs.existsSync(path.join(root, 'src/sum.js')));
    const afterEdit = await call('edit', {
      path: 'src/sum.js',
      edits: [{ oldText: 'return a - b;', newText: 'return a + b;' }],
    });
    expect('edit rewrites the file', fs.readFileSync(path.join(root, 'src/sum.js'), 'utf8')
      .includes('return a + b;'), afterEdit);
    expect('an edit whose text is absent is reported, not skipped',
      (await call('edit', { path: 'src/sum.js', edits: [{ oldText: 'nope', newText: 'x' }] }))
        .includes('not found'), 'the model has to be told to re-read');
    const read = await call('read', { path: 'src/sum.js' });
    expect('read numbers the lines', /1\s+export function add/.test(read), read);
    expect('an escape is refused', (await call('read', { path: '../../etc/passwd' }))
      .includes('outside the workspace'));
    fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'export const hidden = 1;\n');
    const globbed = await call('glob', { pattern: '**/*.js' });
    expect('glob finds the real file', globbed.includes('src/sum.js'), globbed);
    expect('glob skips node_modules', !globbed.includes('node_modules'), globbed);
    const ran = await call('bash', { command: 'node -p 6*7' });
    expect('bash runs through argv, not a shell', ran.includes('42'), ran);
    for (const mode of ['read-only', 'workspace', 'ask', 'full']) {
      expect('rm -rf / is denied in ' + mode + ' mode',
        decide({ toolName: 'bash', args: { command: 'rm -rf /' }, mode }).decision === 'deny');
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (problems.length > 0) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log('write, edit, read, glob, bash, and the deny rules all behaved');
  " 2>&1)"
  if [ $? -eq 0 ]; then
    ok "the workspace tools work on this filesystem"
    [ "$QUIET" -eq 1 ] || printf '         %s\n' "$TOOLS_OUT"
  else
    fail "the workspace tools work on this filesystem" "$TOOLS_OUT"
  fi
fi

# -------------------------------------------------------------------- boundary
# The vitest boundary test is the real gate, but it needs node_modules. These
# greps keep the boundary enforced on a device where vitest cannot run.
section "boundary"

if grep -rn --include='*.ts' --include='*.mjs' -E "from ['\"]openclaw(/|['\"])" "$PACKAGE_ROOT/src" "$PACKAGE_ROOT/bin" >/dev/null 2>&1; then
  fail "no imports of the openclaw root package" \
    "$(grep -rn --include='*.ts' --include='*.mjs' -E "from ['\"]openclaw(/|['\"])" "$PACKAGE_ROOT/src" "$PACKAGE_ROOT/bin")"
else
  ok "no imports of the openclaw root package"
fi

if grep -rn --include='*.ts' -E "from ['\"](\.\./)+(src|extensions)/" "$PACKAGE_ROOT/src" >/dev/null 2>&1; then
  fail "no imports from the desktop host's src/ or extensions/" \
    "$(grep -rn --include='*.ts' -E "from ['\"](\.\./)+(src|extensions)/" "$PACKAGE_ROOT/src")"
else
  ok "no imports from the desktop host's src/ or extensions/"
fi

# Captured and filtered in one pass, then tested for emptiness. Piping into
# `grep -q` here would be actively dangerous: `grep -q` exits on the first match,
# its upstream greps die of SIGPIPE, and under `pipefail` that non-zero status
# would be read as "no violation" — a false negative on the rule that matters most.
CONTAMINATION="$(grep -rn --include='*.ts' --include='*.mjs' -E "plugin-sdk|memory-host-sdk|node-pty" \
  "$PACKAGE_ROOT/src" "$PACKAGE_ROOT/bin" 2>/dev/null || true)"
CONTAMINATION_IMPORTS=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  # Drop the `path:lineno:` prefix grep adds, so what remains is source text.
  body="${line#*:[0-9]:}"
  if [ "$body" = "$line" ]; then
    body="$(printf '%s' "$line" | sed -E 's/^[^:]+:[0-9]+://')"
  fi
  # Strip leading whitespace, then skip comments. Prose that explains the
  # boundary — including prose quoting an import — is not a violation, and a
  # check that flags it would be "fixed" by deleting the explanation.
  trimmed="${body#"${body%%[![:space:]]*}"}"
  case "$trimmed" in
    "//"* | "*"* | "/*"* | "#!"*) continue ;;
  esac
  case "$trimmed" in
    *"from '"* | *'from "'* | *"require("* | *"import("* | *"import '"* | *'import "'*)
      CONTAMINATION_IMPORTS="$CONTAMINATION_IMPORTS$line"$'\n'
      ;;
  esac
done <<EOF
$CONTAMINATION
EOF
if [ -n "$CONTAMINATION_IMPORTS" ]; then
  fail "no plugin-sdk / memory-host-sdk / node-pty imports" "$CONTAMINATION_IMPORTS"
else
  ok "no plugin-sdk / memory-host-sdk / node-pty imports"
fi

# The only permitted upward import is the shared Node version contract.
UPWARD="$(grep -rn --include='*.ts' -E "from ['\"](\.\./){3,}" "$PACKAGE_ROOT/src" || true)"
if [ -z "$UPWARD" ]; then
  fail "the shared node-version contract is still imported" \
    "expected node-requirement.ts to reuse $REPO_ROOT/node-version.mjs; a locally re-declared floor would drift"
elif [ "$(printf '%s\n' "$UPWARD" | grep -c 'node-version.mjs')" -eq "$(printf '%s\n' "$UPWARD" | grep -c .)" ]; then
  ok "the only upward import is the shared node-version contract"
else
  fail "the only upward import is the shared node-version contract" "$UPWARD"
fi

# Dependencies are the part of an install a device cannot reason about on its own.
# ClawAgent reads the shared cores from this checkout instead of installing them,
# so those cores' own npm dependencies never arrive automatically: ClawAgent has
# to declare them, and the list has to match what the cores actually ask for.
# A missing entry surfaces as ERR_MODULE_NOT_FOUND inside a provider transport,
# which on a phone reads like a broken install rather than a stale manifest.
if [ -d "$REPO_ROOT/packages" ]; then
  DEP_REPORT="$(node $NODE_FLAGS --input-type=module -e "
    const { readFileSync } = await import('node:fs');
    const {
      REUSED_PACKAGES,
      collectRequiredExternalDependencies,
    } = await import('file://$PACKAGE_ROOT/src/runtime/reused-packages.ts');
    const manifest = JSON.parse(readFileSync('$PACKAGE_ROOT/package.json', 'utf8'));
    const deps = manifest.dependencies ?? {};
    const problems = [];
    if (!manifest.bin?.clawagent) problems.push('no clawagent bin');
    if (manifest.type !== 'module') problems.push('type must be module');
    if (Object.keys(manifest.optionalDependencies ?? {}).length > 0) {
      problems.push('optionalDependencies must stay empty: that is where a native addon hides');
    }
    const names = Object.keys(deps);
    const external = names.filter((n) => !n.startsWith('@openclaw/'));
    // The reused cores are resolved from this checkout, never installed. They are
    // recorded in clawagent.reusedPackages rather than in dependencies
    // because the only range that could express that link is workspace:*, a
    // pnpm protocol that makes npm install — the install line the README gives
    // a phone user — fail with EUNSUPPORTEDPROTOCOL before it fetches anything.
    const reused = [...REUSED_PACKAGES].sort();
    const recorded = [...(manifest.clawagent?.reusedPackages ?? [])].sort();
    for (const missing of reused.filter((n) => !recorded.includes(n))) {
      problems.push('reused core not recorded: @openclaw/' + missing);
    }
    for (const extra of recorded.filter((n) => !reused.includes(n))) {
      problems.push('recorded core is not on the reuse list: @openclaw/' + extra);
    }
    for (const name of names) {
      if (name.startsWith('@openclaw/')) {
        problems.push(name + ' must not be in dependencies: it is read from the checkout, and any range for it either fetches a published copy over this one or breaks npm install');
      }
    }
    for (const [name, range] of Object.entries(deps)) {
      if (range.includes(':') || /[^0-9.\-+~^|<>=(), x]/u.test(range)) {
        problems.push(name + ' has a range npm cannot install from the registry: "' + range + '"');
      }
    }
    const { required, conflicts } = collectRequiredExternalDependencies('$REPO_ROOT/packages');
    for (const conflict of conflicts) {
      problems.push('cores disagree on ' + conflict.name + ': ' + conflict.ranges.join(' vs '));
    }
    for (const name of Object.keys(required).sort()) {
      if (deps[name] === undefined) problems.push('missing external dependency: ' + name);
      else if (deps[name] !== required[name]) {
        problems.push(name + ' pinned to ' + deps[name] + ', cores want ' + required[name]);
      }
    }
    for (const name of external) {
      if (required[name] === undefined) {
        problems.push('external dependency nothing needs: ' + name);
      }
    }
    const native = [/^node-pty$/, /^sharp$/, /^canvas$/, /^better-sqlite3$/, /^sqlite3$/, /^@lydell\//, /^esbuild$/];
    for (const name of names) {
      if (native.some((pattern) => pattern.test(name))) {
        problems.push('native addon cannot run on Termux: ' + name);
      }
    }
    if (problems.length > 0) {
      process.stdout.write(problems.join('\n'));
      process.exit(1);
    }
    process.stdout.write(
      'dependencies: ' + recorded.length + ' cores from the checkout, '
      + external.length + ' external from the registry',
    );
  " 2>&1)"
  if [ $? -eq 0 ]; then
    ok "package.json dependencies match what the reused cores need"
    [ "$QUIET" -eq 1 ] || printf '         %s\n' "$DEP_REPORT"
  else
    fail "package.json dependencies match what the reused cores need" "$DEP_REPORT"
  fi
else
  ok "skipped: no packages/ checkout to compare dependencies against"
fi

# ---------------------------------------------------------------------- termux
section "termux-specific"

if [ "$ON_TERMUX" -eq 1 ]; then
  case "$DOCTOR_OUT" in
    *"host: Termux"*) ok "doctor detects the Termux host" ;;
    *) fail "doctor detects the Termux host" "$DOCTOR_OUT" ;;
  esac

  # The home must be $PREFIX/../home, never $PREFIX/home: the latter does not
  # exist and silently breaks every write.
  TERMUX_HOME="$(HOME="${PREFIX%/usr}" node -e '
    process.stdout.write(String(process.env.HOME));
  ' 2>/dev/null)"
  case "$TERMUX_HOME" in
    *"/files/usr/home") fail "Termux home is not \$PREFIX/home" "$TERMUX_HOME" ;;
    *) ok "Termux home is not \$PREFIX/home" ;;
  esac

  if command -v termux-wake-lock >/dev/null 2>&1; then
    ok "termux-api is installed"
    if WAKE_OUT="$(termux-wake-lock 2>&1 && termux-wake-unlock 2>&1)"; then
      ok "wake lock can be acquired and released"
    else
      fail "wake lock can be acquired and released" "$WAKE_OUT"
    fi
  else
    fail "termux-api is installed" \
      "pkg install termux-api, then install the Termux:API app from F-Droid"
  fi

  # Without a wake lock Android suspends the Gateway as soon as the screen turns
  # off, so this is reported even though it does not block the run.
  case "$DOCTOR_OUT" in
    *"Wake lock"*) ok "doctor reports wake-lock capability" ;;
    *) fail "doctor reports wake-lock capability" "$DOCTOR_OUT" ;;
  esac
else
  ok "skipped: not running on Termux"
fi

# --------------------------------------------------------------------- summary
echo
echo "smoke test summary: $PASSED passed, $FAILED failed"
if [ "$FAILED" -gt 0 ]; then
  echo "failed checks:"
  for name in "${FAILED_NAMES[@]}"; do
    echo "  - $name"
  done
  exit 1
fi
echo "all checks passed"
exit 0
