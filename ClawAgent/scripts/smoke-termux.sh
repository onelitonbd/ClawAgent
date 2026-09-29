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

# ------------------------------------------------------------------ the whole
# Every production module must load on its own. This is the substitute for a
# typecheck on a device: it proves each file survives type stripping and that
# every relative specifier actually resolves, which is the failure mode the
# `.js`-vs-`.ts` decision exists to prevent.
section "modules load"

MODULE_FAILURES=0
while IFS= read -r module; do
  rel="${module#"$PACKAGE_ROOT"/}"
  case "$rel" in
    *.test.ts | test/*) continue ;;
  esac
  if out="$(node --input-type=module -e "await import('file://$module');" 2>&1)"; then
    ok "$rel"
  else
    fail "$rel failed to load" "$out"
    MODULE_FAILURES=$((MODULE_FAILURES + 1))
  fi
done < <(find "$PACKAGE_ROOT/src" "$PACKAGE_ROOT/bin" -type f \( -name '*.ts' -o -name '*.mjs' \) | sort)

if [ "$MODULE_FAILURES" -eq 0 ]; then
  ok "public barrel imports cleanly"
  check "src/index.ts resolves" 0 node --input-type=module -e \
    "await import('file://$PACKAGE_ROOT/src/index.ts');"
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
for command in doctor version help; do
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

if node -e '
  const manifest = require(process.argv[1]);
  const deps = Object.keys(manifest.dependencies ?? {});
  const optional = Object.keys(manifest.optionalDependencies ?? {});
  if (deps.length > 0) throw new Error("runtime dependencies: " + deps.join(", "));
  if (optional.length > 0) throw new Error("optional dependencies: " + optional.join(", "));
  if (!manifest.bin?.clawagent) throw new Error("no clawagent bin");
  if (manifest.type !== "module") throw new Error("type must be module");
' "$PACKAGE_ROOT/package.json" 2>/dev/null; then
  ok "package.json has zero runtime dependencies and a bin"
else
  fail "package.json has zero runtime dependencies and a bin" \
    "$(node -e '
      const manifest = require(process.argv[1]);
      process.stdout.write(JSON.stringify({
        dependencies: manifest.dependencies ?? {},
        optionalDependencies: manifest.optionalDependencies ?? {},
        bin: manifest.bin ?? {},
        type: manifest.type,
      }, null, 2));
    ' "$PACKAGE_ROOT/package.json" 2>&1)"
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
