#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill — PreToolUse hook (immersive mode gate).
#
# Unlike the other two hooks, this one fires on EVERY Write / Edit / Bash
# of every session, immersive or not. So the off path is performance
# critical in a way no other part of this plugin is, and it is written
# with bash builtins only — no cat, no grep, no command -v — because on
# Git Bash for Windows every forked subprocess costs more than all the
# logic here combined.
#
# Measured on the dev machine (Windows, Git Bash), per tool call:
#   bare `bash -c 'exit 0'`       ~64ms   <- the floor, not ours to fix
#   short-circuit (immersive off) ~98ms   (~34ms of actual work)
#   full gate     (immersive on) ~490ms   (dominated by the bun spawn)
# Before the builtins-only rewrite the short-circuit was ~147ms.
#
# NOTE: that ~98ms is paid on every Write/Edit/Bash by every user of the
# plugin, immersive or not, purely because the hook is registered in the
# manifest. If that tax proves unacceptable, the alternative is to
# register this hook dynamically in settings.json while immersive is on
# (Tarea I.0.1 proved settings hooks are picked up mid-session) and pay
# nothing at all when it is off.
#
# Fail-open: if anything at all goes wrong the call is allowed. A gate that
# misfires and blocks real work gets the whole plugin uninstalled.
# ---------------------------------------------------------------------------
set -uo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
STATE_DIR="${SOCRATIC_STATE_DIR:-$HOME/.claude/socratic}"
PROFILE="$STATE_DIR/profile.json"

# Cheapest possible rejection first: no profile, nothing to enforce. Done
# before touching stdin so the common case forks nothing at all.
[[ -f "$PROFILE" ]] || exit 0

# Builtin read of the profile ($(<file) does not fork a subprocess) and a
# builtin substring test instead of grep. If the user has never turned
# immersive on, this is where every call ends.
profile_raw="$(<"$PROFILE")"
[[ "$profile_raw" == *'"immersive"'* ]] || exit 0

# Only now is it worth consuming stdin and paying for the engine.
raw=""
IFS= read -r -d '' raw || true

[[ -x "$(command -v bun 2>/dev/null)" ]] || exit 0

LOG="$STATE_DIR/.hook-debug.log"
if [[ -f "$LOG" ]]; then
  size=$(wc -c <"$LOG" 2>/dev/null || echo 0)
  if [[ "${size:-0}" -gt 102400 ]]; then
    : >"$LOG"
  fi
fi

printf '%s' "$raw" | bun run "$SCRIPT_DIR/gate-tool.ts" 2>>"$LOG" || true
exit 0
