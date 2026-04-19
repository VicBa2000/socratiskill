#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill — hook UserPromptSubmit.
#
# Claude Code pasa un JSON via stdin con el campo `prompt` (texto del
# usuario). Este script delega el analisis a build-context.ts — ver ese
# archivo para la logica de deteccion y formato.
#
# Todo el trabajo corre en un unico proceso bun para minimizar el cold
# start por turno. El hook es fail-open: si bun no esta, si el profile
# no existe, o si el JSON es invalido, sale con 0 sin stdout.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

if ! command -v bun >/dev/null 2>&1; then
  exit 0
fi

# Redirect stderr to a rotating debug log instead of /dev/null. Silent
# failures here were unreviewable — now the user can "tail" the log to
# diagnose why context injection is empty without affecting the turn.
STATE_DIR="${SOCRATIC_STATE_DIR:-$HOME/.claude/socratic}"
LOG="$STATE_DIR/.hook-debug.log"
mkdir -p "$STATE_DIR" 2>/dev/null || true
# Simple rotation: truncate when the log exceeds ~100KB.
if [[ -f "$LOG" ]]; then
  size=$(wc -c <"$LOG" 2>/dev/null || echo 0)
  if [[ "${size:-0}" -gt 102400 ]]; then
    : >"$LOG"
  fi
fi

# The hook is fail-open: any bun failure is absorbed by `|| true` so the
# user's turn is never blocked on socratic infra. With `set -e` above,
# the trailing `|| true` is load-bearing, not cosmetic.
bun run "$SCRIPT_DIR/build-context.ts" 2>>"$LOG" || true
exit 0
