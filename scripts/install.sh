#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill — install.sh
#
# Orquestador del bootstrap local. Pasos:
#
#   1. Verifica que `bun` este en el PATH (requerido por los hooks).
#   2. Verifica que `node` este en el PATH (usado por los scripts de install).
#   3. Seedea ~/.claude/socratic/profile.json si no existe (init-profile.sh).
#   4. Registra los hooks UserPromptSubmit + Stop en ~/.claude/settings.json
#      (install-hooks.sh). Idempotente: re-correrlo sobre una instalacion
#      limpia es no-op.
#
# Uso:
#   bash install.sh           # instala todo
#   bash install.sh --dry-run # muestra que haria, sin escribir hooks
#
# La activacion del plugin en si (registrar el marketplace + /plugin install)
# es una accion dentro de Claude Code y NO se automatiza desde aqui. Ver
# README.md para el flujo completo.
#
# Variables de entorno honradas:
#   CLAUDE_SETTINGS        override de ~/.claude/settings.json (para tests)
#   SOCRATIC_STATE_DIR     override de ~/.claude/socratic/    (para tests)
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

err() { printf '%s\n' "$1" >&2; }

# --- 1. bun ----------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  err "error: bun not found in PATH"
  err "  install it first: https://bun.com/docs/installation"
  exit 1
fi
echo "[ok] bun: $(bun --version)"

# --- 2. node ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  err "error: node not found in PATH (required by init-profile.sh and install-hooks.sh)"
  exit 1
fi
echo "[ok] node: $(node --version)"

# --- 3. profile seed -------------------------------------------------------
if [[ ! -x "${SCRIPT_DIR}/init-profile.sh" ]]; then
  chmod +x "${SCRIPT_DIR}/init-profile.sh" 2>/dev/null || true
fi
echo "[step] seeding profile.json..."
bash "${SCRIPT_DIR}/init-profile.sh"

# --- 4. hook registration --------------------------------------------------
echo "[step] registering hooks in settings.json..."
if [[ "$DRY_RUN" == "1" ]]; then
  bash "${SCRIPT_DIR}/install-hooks.sh" --dry-run
else
  bash "${SCRIPT_DIR}/install-hooks.sh"
fi

echo ""
echo "[done] socratiskill local state installed."
echo ""
echo "Next steps (inside Claude Code, manual):"
echo "  /plugin marketplace add <path-to-this-repo>"
echo "  /plugin install socratiskill@socratiskill"
echo "  /reload-plugins"
echo "  /socratiskill:socratic calibrate"
echo ""
echo "To disable without uninstalling: /socratiskill:socratic off"
echo "To fully uninstall:              bash ${SCRIPT_DIR}/uninstall.sh"
