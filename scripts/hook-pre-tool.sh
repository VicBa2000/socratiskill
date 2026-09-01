#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill — PreToolUse hook (the authorship gate).
#
# Unlike the other two hooks, this one fires on EVERY Write / Edit / Bash
# of every session, whatever the level. So the disarmed path is
# performance critical in a way no other part of this plugin is, and it is
# written with bash builtins only — no cat, no grep, no command -v —
# because on Git Bash for Windows every forked subprocess costs more than
# all the logic here combined.
#
# Measured on the dev machine (Windows, Git Bash), per tool call:
#   bare `bash -c 'exit 0'`   ~64ms   <- the floor, not ours to fix
#   short-circuit (disarmed)  ~98ms   (~34ms of actual work)
#   full gate     (armed)    ~490ms   (dominated by the bun spawn)
# Before the builtins-only rewrite the short-circuit was ~147ms.
#
# NOTE: that ~98ms is paid on every Write/Edit/Bash by every user of the
# plugin, armed or not, purely because the hook is registered in the
# manifest. If that tax proves unacceptable, the alternative is to
# register this hook dynamically in settings.json while the axis is armed
# (Tarea I.0.1 proved settings hooks are picked up mid-session) and pay
# nothing at all otherwise.
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

# Builtin read of the profile ($(<file) does not fork a subprocess).
profile_raw="$(<"$PROFILE")"

# Plugin switched off entirely. Both spacings, because this file is
# written by JSON.stringify in some paths and by a heredoc in others.
[[ "$profile_raw" == *'"enabled": false'* ]] && exit 0
[[ "$profile_raw" == *'"enabled":false'* ]] && exit 0

# The gate is armed only on levels 2-5. Level 1 is the agent's job, level
# 6 is the axis switched off, and a missing/garbled level means we do not
# know — all three end here rather than paying for the engine.
#
# Parsed with parameter expansion rather than grep/sed: this runs on every
# tool call and a fork here would cost more than the whole check.
lvl=""
if [[ "$profile_raw" == *'"global_level"'* ]]; then
  tail_="${profile_raw#*\"global_level\"}"   # everything after the key
  tail_="${tail_#*:}"                        # everything after the colon
  tail_="${tail_#"${tail_%%[![:space:]]*}"}" # strip leading whitespace
  lvl="${tail_:0:1}"
fi
[[ "$lvl" == [2-5] ]] || exit 0

# Only now is it worth consuming stdin and paying for the engine. An open
# escape also disarms the gate, but detecting one needs real date math, so
# that decision belongs to gate-tool.ts.
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
