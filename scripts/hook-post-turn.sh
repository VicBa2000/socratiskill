#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill — hook Stop.
#
# Claude Code pasa un JSON via stdin con `session_id` y `transcript_path`.
# Este script delega el trabajo a record-turn.ts — ver ese archivo.
#
# Fail-open: si bun no esta disponible o algo falla, sale 0 para no
# afectar al usuario.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

if ! command -v bun >/dev/null 2>&1; then
  exit 0
fi

# Same rotating debug log as the pre-prompt hook. Share the file so a
# tail -f shows both sides of a turn interleaved.
STATE_DIR="${SOCRATIC_STATE_DIR:-$HOME/.claude/socratic}"
LOG="$STATE_DIR/.hook-debug.log"
mkdir -p "$STATE_DIR" 2>/dev/null || true
if [[ -f "$LOG" ]]; then
  size=$(wc -c <"$LOG" 2>/dev/null || echo 0)
  if [[ "${size:-0}" -gt 102400 ]]; then
    : >"$LOG"
  fi
fi

# Fail-open: `|| true` absorbs any bun error so telemetry failures never
# block the user's turn. Load-bearing under `set -e`.
bun run "$SCRIPT_DIR/record-turn.ts" 2>>"$LOG" || true
exit 0
