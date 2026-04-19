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
set -uo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

if ! command -v bun >/dev/null 2>&1; then
  exit 0
fi

bun run "$SCRIPT_DIR/build-context.ts" 2>/dev/null || true
exit 0
