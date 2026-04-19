#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill — install-hooks.sh
#
# Registra los hooks UserPromptSubmit y Stop en ~/.claude/settings.json
# apuntando a los scripts del plugin. Idempotente:
#
#   - Busca y remueve cualquier entry previo cuyo command apunte a un
#     script socratiskill (produccion o test de FASE 0); luego agrega el
#     entry de produccion actual.
#   - Preserva todos los demas hooks y campos del archivo.
#   - Crea ~/.claude/settings.json si no existe.
#
# Uso:
#   bash install-hooks.sh           # instala apuntando a este dir
#   bash install-hooks.sh --dry-run # muestra el resultado sin escribir
#
# El archivo de settings respeta la variable CLAUDE_SETTINGS si esta
# definida (util para tests).
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SETTINGS_PATH="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

PRE_CMD="bash ${SCRIPT_DIR}/hook-pre-prompt.sh"
POST_CMD="bash ${SCRIPT_DIR}/hook-post-turn.sh"

mkdir -p "$(dirname "$SETTINGS_PATH")"
[[ -f "$SETTINGS_PATH" ]] || echo '{}' > "$SETTINGS_PATH"

SOCRATIC_RE='socratiskill.*hook-(pre-prompt|post-turn)(-test)?\.sh'

export SETTINGS_PATH PRE_CMD POST_CMD SOCRATIC_RE DRY_RUN

node -e '
  const fs = require("fs");
  const path = process.env.SETTINGS_PATH;
  let data = {};
  try { data = JSON.parse(fs.readFileSync(path, "utf-8")); } catch (e) { data = {}; }
  if (!data || typeof data !== "object") data = {};
  if (!data.hooks || typeof data.hooks !== "object") data.hooks = {};

  const re = new RegExp(process.env.SOCRATIC_RE);

  function purge(event) {
    const arr = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
    const kept = [];
    for (const entry of arr) {
      const hooks = Array.isArray(entry && entry.hooks) ? entry.hooks : [];
      const hasOurs = hooks.some(h => h && typeof h.command === "string" && re.test(h.command));
      if (!hasOurs) kept.push(entry);
    }
    data.hooks[event] = kept;
  }

  purge("UserPromptSubmit");
  purge("Stop");

  data.hooks.UserPromptSubmit.push({
    hooks: [{ type: "command", command: process.env.PRE_CMD }]
  });
  data.hooks.Stop.push({
    hooks: [{ type: "command", command: process.env.POST_CMD }]
  });

  const out = JSON.stringify(data, null, 2) + "\n";
  if (process.env.DRY_RUN === "1") {
    process.stdout.write(out);
  } else {
    fs.writeFileSync(path, out);
    process.stdout.write("installed: " + path + "\n");
    process.stdout.write("  UserPromptSubmit -> " + process.env.PRE_CMD + "\n");
    process.stdout.write("  Stop             -> " + process.env.POST_CMD + "\n");
  }
'
