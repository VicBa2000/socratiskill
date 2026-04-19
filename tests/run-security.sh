#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill — adversarial security test harness.
#
# Complements run-all.sh: that suite covers the pedagogical flow
# (hints escalate, calibration fires, journals render); this one
# covers the threat model introduced by the v0.1 audit:
#
#   SEC-1  uninstall cannot rm -rf outside ~/.claude/socratic
#   SEC-2  corrupt session JSON never kills start/end-teach or the hook
#   SEC-3  writeJsonAtomic never leaves a half-written file visible
#   SEC-4  concurrent hooks on profile.json never lose writes
#   SEC-5  antipatterns regex guards clamp oversized definitions
#   SEC-6  hooks tolerate hostile / garbage stdin without side effects
#
# A passing run proves that the security guards added in the audit
# actually engage end-to-end, not just in unit-level smoke tests.
#
# Usage:
#   bash tests/run-security.sh              # run everything
#   bash tests/run-security.sh --only <N>   # run only SEC-<N>
#   bash tests/run-security.sh --list       # list scenarios
#   bash tests/run-security.sh --stop-on-fail
#
# Exit codes: 0 all pass, 1 at least one fail.
# ---------------------------------------------------------------------------
set -uo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PLUGIN_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
SCRIPTS="${PLUGIN_DIR}/scripts"

# Bun/node on Git Bash cannot resolve module imports with POSIX-style paths
# (`/c/proyectos/...`); they need Windows-native (`C:/proyectos/...`). Use
# cygpath to normalize for use inside generated `.ts` files. No-op on
# macOS/Linux where mktemp/cwd already produce portable paths.
if command -v cygpath >/dev/null 2>&1; then
  SCRIPTS_WIN="$(cygpath -m "$SCRIPTS")"
else
  SCRIPTS_WIN="$SCRIPTS"
fi

# --- output helpers --------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()
STOP_ON_FAIL=0
ONLY=""
LIST_MODE=0

for arg in "$@"; do
  case "$arg" in
    --stop-on-fail) STOP_ON_FAIL=1 ;;
    --only) shift; ONLY="${1:-}"; shift || true ;;
    --list) LIST_MODE=1 ;;
    --help|-h) sed -n '1,30p' "$0"; exit 0 ;;
  esac
done

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() {
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
  FAIL_COUNT=$((FAIL_COUNT+1))
  FAILED_TESTS+=("$1")
  if [[ "$STOP_ON_FAIL" == "1" ]]; then
    summary
    exit 1
  fi
}
header() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

summary() {
  echo ""
  echo "====================================================="
  echo "   PASSED: $PASS_COUNT"
  echo "   FAILED: $FAIL_COUNT"
  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    echo ""
    echo "   Failed tests:"
    for t in "${FAILED_TESTS[@]}"; do echo "     - $t"; done
  fi
  echo "====================================================="
}

if [[ "$LIST_MODE" == "1" ]]; then
  cat <<'EOF'
SEC-1 uninstall refuses hostile STATE_DIR
SEC-2 corrupt session JSON is recoverable
SEC-3 atomic writes never expose a half-written file
SEC-4 concurrent hooks on profile.json never lose writes
SEC-5 antipatterns regex guards clamp oversized definitions
SEC-6 hooks tolerate hostile stdin without side effects
SEC-7 topic injection (null bytes, RTL, traversal, control chars)
SEC-8 install-hooks concurrent writes are atomic
EOF
  exit 0
fi

# --- test isolation -------------------------------------------------------
TEST_ROOT="$(mktemp -d -t sksec.XXXXXXXX)"
if command -v cygpath >/dev/null 2>&1; then
  TEST_ROOT="$(cygpath -m "$TEST_ROOT")"
fi
trap 'rm -rf "$TEST_ROOT" 2>/dev/null || true' EXIT

should_run() {
  [[ -z "$ONLY" || "$ONLY" == "$1" ]]
}

today_iso() { node -e 'console.log(new Date().toISOString().slice(0,10))'; }

# ===========================================================================
# SEC-1 — uninstall refuses to rm -rf anything outside ~/.claude/socratic
# ===========================================================================
if should_run 1; then
  header "SEC-1 uninstall refuses hostile STATE_DIR"

  # Build a fake HOME so the guard has a realistic $HOME to clamp against.
  FAKE_HOME="$TEST_ROOT/sec1-home"
  mkdir -p "$FAKE_HOME/.claude/socratic"
  echo "sentinel" > "$FAKE_HOME/sentinel.txt"
  # Victim path the attacker would want to wipe via a symlink / env trick.
  VICTIM="$TEST_ROOT/sec1-victim"
  mkdir -p "$VICTIM"
  echo "do not delete me" > "$VICTIM/important.txt"
  # Legit socratic dir under FAKE_HOME so the happy path has something to remove.
  SOCRATIC_OK="$FAKE_HOME/.claude/socratic"
  echo '{"ok":true}' > "$SOCRATIC_OK/profile.json"
  # Empty settings (uninstall.sh tolerates missing, but we want to test state branch).
  FAKE_SETTINGS="$FAKE_HOME/.claude/settings.json"
  echo '{}' > "$FAKE_SETTINGS"

  run_uninstall() {
    # Isolated HOME so the guard sees a realistic $HOME/... comparison.
    local state="$1"
    HOME="$FAKE_HOME" SOCRATIC_STATE_DIR="$state" CLAUDE_SETTINGS="$FAKE_SETTINGS" \
      bash "$SCRIPTS/uninstall.sh" --purge 2>&1
    return $?
  }

  # 1a — "/" must be rejected
  OUT=$(run_uninstall "/" || true); EX=$?
  if [[ "$OUT" == *"refusing"* ]] && [[ -f "$FAKE_HOME/sentinel.txt" ]]; then
    pass "refuses STATE_DIR=/ (sentinel intact)"
  else
    fail "SEC-1a did not refuse /"
  fi

  # 1b — $HOME itself must be rejected
  OUT=$(run_uninstall "$FAKE_HOME" || true)
  if [[ "$OUT" == *"refusing"* || "$OUT" == *"abort"* ]] && [[ -f "$FAKE_HOME/sentinel.txt" ]]; then
    pass "refuses STATE_DIR=\$HOME (sentinel intact)"
  else
    fail "SEC-1b did not refuse \$HOME (sentinel=$( [[ -f "$FAKE_HOME/sentinel.txt" ]] && echo present || echo MISSING ))"
  fi

  # 1c — path outside $HOME must be rejected
  OUT=$(run_uninstall "$VICTIM" 2>&1 || true)
  if [[ "$OUT" == *"abort"* ]] && [[ -f "$VICTIM/important.txt" ]]; then
    pass "refuses path outside \$HOME (victim intact)"
  else
    fail "SEC-1c did not refuse path outside \$HOME"
  fi

  # 1d — path under $HOME but without .claude/socratic must be rejected
  BAD_UNDER_HOME="$FAKE_HOME/Documents"
  mkdir -p "$BAD_UNDER_HOME"
  echo "docs" > "$BAD_UNDER_HOME/file.txt"
  OUT=$(run_uninstall "$BAD_UNDER_HOME" 2>&1 || true)
  if [[ "$OUT" == *"abort"* ]] && [[ -f "$BAD_UNDER_HOME/file.txt" ]]; then
    pass "refuses \$HOME path without .claude/socratic segment"
  else
    fail "SEC-1d did not refuse \$HOME/Documents"
  fi

  # 1e — relative path must be rejected (non-absolute)
  OUT=$(run_uninstall "foo/bar" 2>&1 || true)
  # Relative paths trigger "no state dir" (it doesn't exist in cwd) OR the
  # absolute-path guard. Either way, SOCRATIC_OK must be intact.
  if [[ -f "$SOCRATIC_OK/profile.json" ]]; then
    pass "relative STATE_DIR cannot escalate to victim (profile intact)"
  else
    fail "SEC-1e relative path touched socratic dir"
  fi

  # 1f — happy path: legit STATE_DIR under $HOME/.claude/socratic is removed
  OUT=$(run_uninstall "$SOCRATIC_OK" 2>&1 || true)
  if [[ "$OUT" == *"removed"* ]] && [[ ! -e "$SOCRATIC_OK" ]]; then
    pass "happy path: legit STATE_DIR is removed"
  else
    fail "SEC-1f happy path did not remove legit dir"
  fi

  # 1g — path traversal via ".." segments.
  # The earlier guards (absolute, under $HOME, contains .claude/socratic)
  # operate on the literal string, so an attacker crafting
  #   $HOME/.claude/socratic/../../../victim
  # passes all three — yet rm -rf resolves ".." at the syscall level and
  # escapes the intended directory. This test proves the dedicated
  # traversal guard is engaged.
  mkdir -p "$FAKE_HOME/.claude/socratic"
  TRAVERSAL="$FAKE_HOME/.claude/socratic/../../../sec1-victim"
  # Fresh victim file for this sub-test (1c may have removed the dir).
  mkdir -p "$VICTIM"
  echo "do not delete via traversal" > "$VICTIM/traversal-bait.txt"
  OUT=$(run_uninstall "$TRAVERSAL" 2>&1 || true)
  if [[ "$OUT" == *".."* || "$OUT" == *"traversal"* || "$OUT" == *"abort"* ]] && [[ -f "$VICTIM/traversal-bait.txt" ]]; then
    pass "refuses '..' traversal (bait intact)"
  else
    fail "SEC-1g traversal bypass (out=$OUT bait=$( [[ -f "$VICTIM/traversal-bait.txt" ]] && echo present || echo GONE ))"
  fi
fi

# ===========================================================================
# SEC-2 — corrupt session JSON never kills teach flows or the hook
# ===========================================================================
if should_run 2; then
  header "SEC-2 corrupt session JSON is recoverable"

  TODAY="$(today_iso)"
  STATE="$TEST_ROOT/sec2-state"
  mkdir -p "$STATE/sessions"
  echo '{"global_level":3,"mode":"learn","calibration_completed":true,"last_active":null}' > "$STATE/profile.json"

  # 2a — start-teach on a corrupt session JSON: backup + fresh start
  printf '{not valid json' > "$STATE/sessions/$TODAY.json"
  SOCRATIC_STATE_DIR="$STATE" bun run "$SCRIPTS/start-teach.ts" --topic "sec-test-2a" >/dev/null 2>&1
  EX=$?
  BACKUPS=$(ls "$STATE/sessions/" | grep -c "\.corrupt-" || true)
  HAS_FEYNMAN=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); console.log(d.feynman?.topic ?? "none")' "$STATE/sessions/$TODAY.json" 2>/dev/null || echo "parse-fail")
  if [[ "$EX" == "0" && "$BACKUPS" -ge 1 && "$HAS_FEYNMAN" == "sec-test-2a" ]]; then
    pass "start-teach recovers corrupt session (backup=$BACKUPS, feynman=$HAS_FEYNMAN)"
  else
    fail "SEC-2a start-teach did not recover (exit=$EX backup=$BACKUPS feynman=$HAS_FEYNMAN)"
  fi

  # Clean up for 2b
  rm -rf "$STATE/sessions"
  mkdir -p "$STATE/sessions"

  # 2b — end-teach on a corrupt session JSON: abort exit 2, backup created,
  #      no writes to original
  printf '{corrupt end-teach' > "$STATE/sessions/$TODAY.json"
  ORIG_CONTENT=$(cat "$STATE/sessions/$TODAY.json")
  OUT=$(SOCRATIC_STATE_DIR="$STATE" bun run "$SCRIPTS/end-teach.ts" 2>&1) || EX=$?
  EX=${EX:-0}
  NEW_CONTENT=$(cat "$STATE/sessions/$TODAY.json")
  BACKUPS=$(ls "$STATE/sessions/" | grep -c "\.corrupt-" || true)
  if [[ "$EX" == "2" && "$NEW_CONTENT" == "$ORIG_CONTENT" && "$BACKUPS" -ge 1 ]]; then
    pass "end-teach aborts on corrupt session (original preserved, backup=$BACKUPS)"
  else
    fail "SEC-2b end-teach did not abort safely (exit=$EX preserved=$([[ "$NEW_CONTENT" == "$ORIG_CONTENT" ]] && echo y || echo N) backup=$BACKUPS)"
  fi

  # 2c — record-turn hook on a corrupt session JSON: exit 0, no crash
  rm -rf "$STATE/sessions"
  mkdir -p "$STATE/sessions"
  printf 'garbage' > "$STATE/sessions/$TODAY.json"
  TR="$STATE/t.jsonl"
  node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({type:"user",message:{content:"q"}})+"\n"+JSON.stringify({type:"assistant",message:{content:"ok\n<!-- HINT_META {\"topic\":\"t\",\"correct\":null,\"domain\":\"web\",\"hintLevel\":0} /HINT_META -->"}})+"\n");' "$TR"
  SOCRATIC_STATE_DIR="$STATE" bash "$SCRIPTS/hook-post-turn.sh" <<EOF >/dev/null 2>&1
{"session_id":"s","transcript_path":"$TR","hook_event_name":"Stop"}
EOF
  EX=$?
  if [[ "$EX" == "0" ]]; then
    pass "record-turn hook tolerates corrupt session (exit=0)"
  else
    fail "SEC-2c hook crashed on corrupt session (exit=$EX)"
  fi
fi

# ===========================================================================
# SEC-3 — atomic writes never expose a half-written file
# ===========================================================================
if should_run 3; then
  header "SEC-3 atomic writes never expose a half-written file"

  STATE="$TEST_ROOT/sec3-state"
  mkdir -p "$STATE"

  # 3a — throw during writeJsonAtomic leaves target untouched
  echo '{"v":"original"}' > "$STATE/t.json"
  cat > "$TEST_ROOT/sec3a.ts" <<EOF
import { StateIO } from "${SCRIPTS_WIN}/state-io"
const path = process.argv[2]
try {
  // Force a throw by passing unserializable data (a BigInt).
  StateIO.writeJsonAtomic(path, { x: 1n })
} catch {
  // expected
}
EOF
  bun run "$TEST_ROOT/sec3a.ts" "$STATE/t.json" 2>/dev/null || true
  CONTENT=$(cat "$STATE/t.json")
  TMP_COUNT=$(ls "$STATE" | grep -c '\.tmp-' || true)
  if [[ "$CONTENT" == '{"v":"original"}' && "$TMP_COUNT" == "0" ]]; then
    pass "throw during write leaves original intact + tmp cleaned"
  else
    fail "SEC-3a content changed or tmp leaked (content=$CONTENT tmps=$TMP_COUNT)"
  fi

  # 3b — stray tmp file does not break the next atomic write
  echo 'not-json-garbage-tmp' > "$STATE/t.json.tmp-99999-123"
  cat > "$TEST_ROOT/sec3b.ts" <<EOF
import { StateIO } from "${SCRIPTS_WIN}/state-io"
StateIO.writeJsonAtomic(process.argv[2], { v: "fresh" })
EOF
  bun run "$TEST_ROOT/sec3b.ts" "$STATE/t.json" 2>/dev/null
  EX=$?
  AFTER=$(cat "$STATE/t.json" | tr -d '[:space:]')
  if [[ "$EX" == "0" && "$AFTER" == '{"v":"fresh"}' ]]; then
    pass "stray orphan tmp does not block next atomic write"
  else
    fail "SEC-3b atomic write failed (exit=$EX content=$AFTER)"
  fi

  # Remove the intentional stray tmp from 3b before the parallel test so
  # we're only counting tmps that were actually produced (and not cleaned
  # up) during 3c.
  rm -f "$STATE"/*.tmp-* 2>/dev/null || true

  # 3c — 10 parallel writers leave the target valid JSON (any one wins)
  cat > "$TEST_ROOT/sec3c.ts" <<EOF
import { StateIO } from "${SCRIPTS_WIN}/state-io"
const id = process.argv[3]
for (let i = 0; i < 5; i++) {
  StateIO.writeJsonAtomic(process.argv[2], { writer: id, iter: i })
}
EOF
  for i in 1 2 3 4 5 6 7 8 9 10; do
    bun run "$TEST_ROOT/sec3c.ts" "$STATE/t.json" "w$i" 2>/dev/null &
  done
  wait
  # Must still be parseable; any writer may have won the last slot.
  VALID=$(node -e 'try { const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); console.log(d.writer ? "y" : "n") } catch { console.log("n") }' "$STATE/t.json")
  TMP_COUNT=$(ls "$STATE" | grep -c '\.tmp-' || true)
  if [[ "$VALID" == "y" && "$TMP_COUNT" == "0" ]]; then
    pass "10 parallel writers leave valid JSON + zero stray tmps"
  else
    fail "SEC-3c parallel writes corrupted (valid=$VALID tmps=$TMP_COUNT)"
  fi
fi

# ===========================================================================
# SEC-4 — concurrent hooks on profile.json never lose writes
# ===========================================================================
if should_run 4; then
  header "SEC-4 concurrent RMW on profile.json never loses writes"

  STATE="$TEST_ROOT/sec4-state"
  mkdir -p "$STATE"
  echo '{"global_level":3,"counter_a":0,"counter_b":0,"counter_c":0}' > "$STATE/profile.json"

  cat > "$TEST_ROOT/sec4.ts" <<EOF
import { StateIO } from "${SCRIPTS_WIN}/state-io"
import { readFileSync } from "node:fs"
const profile = process.argv[2]
const lock = profile + ".lock"
const field = process.argv[3]  // counter_a / counter_b / counter_c
for (let i = 0; i < 30; i++) {
  StateIO.withLock(lock, () => {
    const doc = JSON.parse(readFileSync(profile, "utf-8"))
    doc[field] = (doc[field] ?? 0) + 1
    // Simulate per-hook work: read, mutate, 2ms hold, write. This reproduces
    // the real race window we hit in record-turn / build-context.
    const ia = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(ia, 0, 0, 2)
    StateIO.writeJsonAtomic(profile, doc)
  })
}
EOF

  for role in a b c; do
    bun run "$TEST_ROOT/sec4.ts" "$STATE/profile.json" "counter_$role" 2>/dev/null &
  done
  wait

  FINAL=$(cat "$STATE/profile.json")
  CA=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).counter_a)' "$STATE/profile.json")
  CB=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).counter_b)' "$STATE/profile.json")
  CC=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).counter_c)' "$STATE/profile.json")
  LOCK_LEAK=$(ls "$STATE" | grep -c '\.lock' || true)

  if [[ "$CA" == "30" && "$CB" == "30" && "$CC" == "30" ]]; then
    pass "3 parallel writers × 30 RMW = 30/30/30 (got $CA/$CB/$CC)"
  else
    fail "SEC-4a lost writes (got $CA/$CB/$CC)"
  fi
  if [[ "$LOCK_LEAK" == "0" ]]; then
    pass "no orphan .lock files after concurrent run"
  else
    fail "SEC-4b $LOCK_LEAK orphan .lock files"
  fi

  # 4c — stale lock is reclaimed (age > 5s)
  # Create a pretend lock file with old mtime. Some `touch -d` syntaxes vary
  # across Unix/Git Bash; pick the portable one.
  STALE_LOCK="$STATE/profile.json.lock"
  : > "$STALE_LOCK"
  if command -v touch >/dev/null 2>&1; then
    touch -d "10 seconds ago" "$STALE_LOCK" 2>/dev/null || touch -t $(date -d "10 seconds ago" +%Y%m%d%H%M.%S 2>/dev/null || echo 200001010000.00) "$STALE_LOCK" 2>/dev/null || true
  fi
  cat > "$TEST_ROOT/sec4c.ts" <<EOF
import { StateIO } from "${SCRIPTS_WIN}/state-io"
StateIO.withLock(process.argv[2], () => {
  process.stdout.write("acquired\n")
}, { maxAttempts: 5, backoffMs: 50, staleMs: 5000 })
EOF
  OUT=$(bun run "$TEST_ROOT/sec4c.ts" "$STALE_LOCK" 2>&1)
  if [[ "$OUT" == "acquired" ]]; then
    pass "stale lock (>5s) is reclaimed"
  else
    fail "SEC-4c stale lock not reclaimed (out=$OUT)"
  fi
fi

# ===========================================================================
# SEC-5 — antipatterns regex guards clamp oversized definitions
# ===========================================================================
if should_run 5; then
  header "SEC-5 antipattern regex guards clamp oversized definitions"

  # Test scanText() directly with hostile definitions. We bypass the JSON
  # file since the guards live in scanText, not in loadDefinitions.
  cat > "$TEST_ROOT/sec5.ts" <<EOF
import { Antipatterns } from "${SCRIPTS_WIN}/antipatterns"

const big = "a".repeat(1001)
const bigFlags = "gimsuy" + "x".repeat(20)
const normalInput = "aaaaaaaaaa match me"

// 5a — oversized regex skipped
const r1 = Antipatterns.scanText(normalInput, [
  { id: "big-regex", regex: big, flags: "g" } as any,
  { id: "ok",         regex: "match me",  flags: "g" } as any,
])
console.log("r1:", JSON.stringify(r1))

// 5b — oversized flags skipped
const r2 = Antipatterns.scanText(normalInput, [
  { id: "big-flags", regex: "a+", flags: bigFlags } as any,
  { id: "ok",        regex: "match me", flags: "g" } as any,
])
console.log("r2:", JSON.stringify(r2))

// 5c — malformed regex caught silently (not blowing up the hook)
const r3 = Antipatterns.scanText(normalInput, [
  { id: "bad-regex", regex: "(unclosed", flags: "g" } as any,
  { id: "ok",        regex: "match me",  flags: "g" } as any,
])
console.log("r3:", JSON.stringify(r3))

// 5d — input longer than MAX_CODE_LEN is truncated: a match past 100KB
// should NOT be found.
const padding = "b".repeat(100_100)
const hidden = padding + "HIDDEN_AT_END"
const r4 = Antipatterns.scanText(hidden, [
  { id: "finds-end", regex: "HIDDEN_AT_END", flags: "g" } as any,
])
console.log("r4:", JSON.stringify(r4))
EOF
  OUT=$(bun run "$TEST_ROOT/sec5.ts" 2>&1)

  # 5a: "big-regex" must be absent, "ok" must match once
  if echo "$OUT" | grep -q '^r1: {"ok":1}$'; then
    pass "oversized regex skipped (good defs still match)"
  else
    fail "SEC-5a oversized regex not skipped (out=$(echo "$OUT" | grep '^r1:'))"
  fi

  # 5b: "big-flags" must be absent, "ok" must match once
  if echo "$OUT" | grep -q '^r2: {"ok":1}$'; then
    pass "oversized flags skipped"
  else
    fail "SEC-5b oversized flags not skipped (out=$(echo "$OUT" | grep '^r2:'))"
  fi

  # 5c: "bad-regex" must be absent, "ok" must match once
  if echo "$OUT" | grep -q '^r3: {"ok":1}$'; then
    pass "malformed regex caught; good defs still scanned"
  else
    fail "SEC-5c malformed regex propagated (out=$(echo "$OUT" | grep '^r3:'))"
  fi

  # 5d: truncation — should NOT find a match past MAX_CODE_LEN
  if echo "$OUT" | grep -q '^r4: {}$'; then
    pass "input truncated to MAX_CODE_LEN (match past 100KB not found)"
  else
    fail "SEC-5d input not truncated (out=$(echo "$OUT" | grep '^r4:'))"
  fi
fi

# ===========================================================================
# SEC-6 — hooks tolerate hostile stdin without side effects
# ===========================================================================
if should_run 6; then
  header "SEC-6 hooks tolerate hostile stdin without side effects"

  STATE="$TEST_ROOT/sec6-state"
  mkdir -p "$STATE/sessions"
  echo '{"global_level":3,"mode":"learn","calibration_completed":true,"last_active":null}' > "$STATE/profile.json"

  # 6a — malformed JSON stdin
  EX=0
  printf 'not-json-at-all' | SOCRATIC_STATE_DIR="$STATE" bash "$SCRIPTS/hook-post-turn.sh" >/dev/null 2>&1 || EX=$?
  printf 'not-json-at-all' | SOCRATIC_STATE_DIR="$STATE" bash "$SCRIPTS/hook-pre-prompt.sh" >/dev/null 2>&1 || EX=$((EX+$?))
  if [[ "$EX" == "0" ]]; then
    pass "malformed JSON stdin → both hooks exit 0"
  else
    fail "SEC-6a hook crashed on malformed JSON (exit=$EX)"
  fi

  # 6b — empty stdin
  EX=0
  printf '' | SOCRATIC_STATE_DIR="$STATE" bash "$SCRIPTS/hook-post-turn.sh" >/dev/null 2>&1 || EX=$?
  if [[ "$EX" == "0" ]]; then
    pass "empty stdin → exit 0"
  else
    fail "SEC-6b hook crashed on empty stdin (exit=$EX)"
  fi

  # 6c — huge garbage stdin (~1MB random bytes)
  EX=0
  head -c 1048576 /dev/urandom 2>/dev/null | SOCRATIC_STATE_DIR="$STATE" bash "$SCRIPTS/hook-post-turn.sh" >/dev/null 2>&1 || EX=$?
  if [[ "$EX" == "0" ]]; then
    pass "1MB random-byte stdin → exit 0"
  else
    fail "SEC-6c hook crashed on binary stdin (exit=$EX)"
  fi

  # 6d — truncated JSON (no closing brace)
  EX=0
  printf '{"session_id":"x","transcript_path":"/nonexistent"' | SOCRATIC_STATE_DIR="$STATE" bash "$SCRIPTS/hook-post-turn.sh" >/dev/null 2>&1 || EX=$?
  if [[ "$EX" == "0" ]]; then
    pass "truncated JSON stdin → exit 0"
  else
    fail "SEC-6d hook crashed on truncated JSON (exit=$EX)"
  fi

  # 6e — verify no session file was created by any of the above
  TODAY="$(today_iso)"
  if [[ ! -f "$STATE/sessions/$TODAY.json" ]]; then
    pass "hostile stdin produced zero session-file side effects"
  else
    fail "SEC-6e hostile stdin wrote a session file"
  fi
fi

# ===========================================================================
# SEC-7 — topic injection: null bytes, RTL, path traversal, control chars
# ===========================================================================
#
# normalizeTopic() keeps only [a-z0-9-] after lowercasing. This block
# drives start-teach.ts with each hostile payload and asserts that:
#   a) the process never crashes and never writes outside the state dir
#   b) every hostile char is stripped from the persisted slug
#   c) any rejection message escapes the raw input (no direct echo of
#      RTL / control chars to the terminal — JSON.stringify handles this)
#   d) the session filename is still the expected date-based path (so a
#      "../../etc/passwd" topic cannot redirect the file write)
#
if should_run 7; then
  header "SEC-7 topic injection resistance"

  TODAY="$(today_iso)"
  STATE="$TEST_ROOT/sec7-state"
  mkdir -p "$STATE/sessions"
  echo '{"global_level":3,"mode":"learn","calibration_completed":true}' > "$STATE/profile.json"

  probe_topic() {
    # $1 = label, $2 = raw topic bytes via printf, $3 = expected slug or "REJECT"
    local label="$1"; local rawhex="$2"; local expect="$3"
    rm -f "$STATE/sessions/$TODAY.json"
    local topic
    topic="$(printf "$rawhex")"
    local out ex=0
    out="$(SOCRATIC_STATE_DIR="$STATE" bun run "$SCRIPTS/start-teach.ts" --topic "$topic" 2>&1)" || ex=$?
    if [[ "$expect" == "REJECT" ]]; then
      if [[ "$ex" != "0" && ! -f "$STATE/sessions/$TODAY.json" ]]; then
        pass "$label: rejected, no session written"
      else
        fail "SEC-7 $label: did not reject (exit=$ex file=$( [[ -f "$STATE/sessions/$TODAY.json" ]] && echo YES || echo no))"
      fi
      return
    fi
    if [[ "$ex" != "0" || ! -f "$STATE/sessions/$TODAY.json" ]]; then
      fail "SEC-7 $label: unexpected rejection (exit=$ex out=$out)"
      return
    fi
    local got
    got="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).feynman.topic)' "$STATE/sessions/$TODAY.json")"
    if [[ "$got" == "$expect" ]]; then
      pass "$label: slug = $got"
    else
      fail "SEC-7 $label: expected '$expect' got '$got'"
    fi
  }

  # 7a — null byte inside a legit topic. JS strings tolerate \0 but it
  # must be stripped from the slug.
  probe_topic "null byte"      'evil\x00script'            "evilscript"

  # 7b — RTL Override (U+202E). Encoded as UTF-8 bytes \xE2\x80\xAE.
  probe_topic "RTL override"   'bad\xe2\x80\xaetxt'        "badtxt"

  # 7c — zero-width joiner (U+200D) and zero-width space (U+200B).
  probe_topic "zero-width"     'clo\xe2\x80\x8dsure\xe2\x80\x8b'  "closure"

  # 7d — path traversal. Slashes are NOT in [a-z0-9-] so they are stripped;
  # the resulting slug must not contain any path separator.
  probe_topic "path traversal" '../../etc/passwd'          "etcpasswd"

  # 7e — windows-style path separator.
  probe_topic "windows sep"    'C:\\foo\\bar'              "cfoobar"

  # 7f — shell metacharacters. Must be stripped; they never reach a shell
  # because we invoke bun directly without shell interpolation. Spaces
  # collapse to dashes via /\s+/g before the non-alnum filter runs, so
  # "$(rm -rf /);`whoami`" -> "rm-rf-whoami".
  probe_topic "shell metas"    '$(rm -rf /);`whoami`'      "rm-rf-whoami"

  # 7g — newline and tab in the topic.
  probe_topic "newline/tab"    'foo\nbar\tbaz'             "foo-bar-baz"

  # 7h — only control chars + whitespace → must be rejected with the
  # "no alphanumeric characters" message.
  probe_topic "all control"    '\x01\x02\x03 \t'           "REJECT"

  # 7i — only RTL + punctuation → reject.
  probe_topic "only RTL"       '\xe2\x80\xae---'           "REJECT"

  # 7j — very long string (>10KB). Normalization truncates to 80 chars.
  LONG="$(printf 'a%.0s' {1..10000})"
  rm -f "$STATE/sessions/$TODAY.json"
  out=$(SOCRATIC_STATE_DIR="$STATE" bun run "$SCRIPTS/start-teach.ts" --topic "$LONG" 2>&1); ex=$?
  got="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).feynman.topic)' "$STATE/sessions/$TODAY.json" 2>/dev/null || echo ERR)"
  if [[ "$ex" == "0" && "${#got}" -le 80 ]]; then
    pass "10KB topic: accepted + truncated to ${#got} chars"
  else
    fail "SEC-7j 10KB topic not handled (exit=$ex len=${#got})"
  fi

  # 7k — no file outside the state dir was created. Walk from TEST_ROOT
  # and check for unexpected files.
  STRAY=$(find "$TEST_ROOT" -type f -name 'passwd' -o -name '*etc*' 2>/dev/null | head -5)
  if [[ -z "$STRAY" ]]; then
    pass "no stray files created outside state dir"
  else
    fail "SEC-7k found stray files: $STRAY"
  fi
fi

# ===========================================================================
# SEC-8 — install-hooks concurrent is atomic
# ===========================================================================
#
# Fire N install-hooks.sh in parallel against the same settings.json and
# assert that (a) the file always parses as JSON, (b) the UserPromptSubmit
# and Stop events each contain exactly ONE entry for socratiskill (the
# dedup regex works), and (c) no .tmp-* files leak.
#
if should_run 8; then
  header "SEC-8 install-hooks concurrent writes are atomic"

  STATE="$TEST_ROOT/sec8-state"
  mkdir -p "$STATE"
  SETTINGS="$STATE/settings.json"
  echo '{}' > "$SETTINGS"

  # Fire 10 parallel installs.
  for i in 1 2 3 4 5 6 7 8 9 10; do
    CLAUDE_SETTINGS="$SETTINGS" bash "$SCRIPTS/install-hooks.sh" >/dev/null 2>&1 &
  done
  wait

  # 8a — final settings is valid JSON
  VALID=$(node -e 'try { JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); console.log("y") } catch { console.log("n") }' "$SETTINGS")
  if [[ "$VALID" == "y" ]]; then
    pass "settings.json is valid JSON after 10 parallel installs"
  else
    fail "SEC-8a settings.json corrupted"
  fi

  # 8b — exactly one socratiskill entry per event (dedup regex engaged)
  COUNTS=$(node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
    const re = /socratiskill.*hook-(pre-prompt|post-turn)(-test)?\.sh/;
    function count(event) {
      const arr = (d.hooks && d.hooks[event]) || [];
      let n = 0;
      for (const entry of arr) {
        const hs = (entry && entry.hooks) || [];
        if (hs.some(h => h && typeof h.command === "string" && re.test(h.command))) n++;
      }
      return n;
    }
    console.log(count("UserPromptSubmit") + "," + count("Stop"));
  ' "$SETTINGS")
  if [[ "$COUNTS" == "1,1" ]]; then
    pass "exactly one entry per event (got $COUNTS)"
  else
    fail "SEC-8b duplicate or missing entries (UserPromptSubmit,Stop = $COUNTS)"
  fi

  # 8c — no orphan .tmp-* files from interrupted renames
  TMPLEAK=$(ls "$STATE" | grep -c '\.tmp-' || true)
  if [[ "$TMPLEAK" == "0" ]]; then
    pass "no orphan .tmp-* files after concurrent installs"
  else
    fail "SEC-8c $TMPLEAK orphan tmp files"
  fi

  # 8d — now seed with a pre-existing unrelated hook and verify it is
  # preserved through concurrent installs (the regex only purges our own)
  cat > "$SETTINGS" <<'JSON'
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "bash /opt/other/thing.sh" }] }
    ],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "bash /opt/audit/pre.sh" }] }
    ]
  }
}
JSON
  for i in 1 2 3 4 5; do
    CLAUDE_SETTINGS="$SETTINGS" bash "$SCRIPTS/install-hooks.sh" >/dev/null 2>&1 &
  done
  wait
  PRESERVED=$(node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
    const ups = (d.hooks && d.hooks.UserPromptSubmit) || [];
    const pre = (d.hooks && d.hooks.PreToolUse) || [];
    const hasOther = ups.some(e => (e.hooks || []).some(h => h.command === "bash /opt/other/thing.sh"));
    const hasPre   = pre.some(e => (e.hooks || []).some(h => h.command === "bash /opt/audit/pre.sh"));
    console.log(hasOther && hasPre ? "y" : "n");
  ' "$SETTINGS")
  if [[ "$PRESERVED" == "y" ]]; then
    pass "unrelated hooks preserved through concurrent installs"
  else
    fail "SEC-8d unrelated hooks lost"
  fi
fi

summary
[[ "$FAIL_COUNT" == "0" ]] || exit 1
