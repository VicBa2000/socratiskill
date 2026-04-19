#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill — uninstall.sh
#
# Reverso de install.sh / install-hooks.sh:
#
#   1. Remueve los entries de socratiskill del hook UserPromptSubmit y Stop
#      en ~/.claude/settings.json. Preserva cualquier otro hook o campo.
#   2. Pregunta si borrar ~/.claude/socratic/ (el historial del usuario).
#
# La desactivacion del plugin en Claude Code (/plugin uninstall) NO se
# automatiza — el usuario lo hace manualmente despues de esto.
#
# Uso:
#   bash uninstall.sh              # interactivo (pregunta por el state)
#   bash uninstall.sh --keep-state # no pregunta, preserva ~/.claude/socratic/
#   bash uninstall.sh --purge      # no pregunta, borra ~/.claude/socratic/
#   bash uninstall.sh --dry-run    # muestra cambios sin escribir
#
# Variables de entorno:
#   CLAUDE_SETTINGS, SOCRATIC_STATE_DIR   overrides para tests
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SETTINGS_PATH="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
STATE_DIR="${SOCRATIC_STATE_DIR:-$HOME/.claude/socratic}"

# Guard: refuse to rm -rf anything that isn't clearly our state dir.
# Must be absolute, under $HOME, contain ".claude/socratic", and not be
# $HOME itself nor a root-level path. Rejection is fatal — better to
# abort than risk deleting the wrong tree.
assert_safe_state_dir() {
  local dir="$1"
  if [[ -z "$dir" ]]; then
    echo "[abort] SOCRATIC_STATE_DIR is empty — refusing to run rm -rf on empty path." >&2
    exit 2
  fi
  # Accept both POSIX absolute (/c/Users/...) and Windows-native
  # absolute (C:/Users/...). Both styles appear on Git Bash depending
  # on how the env var was set; rejecting Windows-native would leave
  # power users unable to override the state dir via Command Prompt.
  case "$dir" in
    /*|[A-Za-z]:/*|[A-Za-z]:\\*) ;;
    *)
      echo "[abort] SOCRATIC_STATE_DIR must be an absolute path, got: $dir" >&2
      exit 2
      ;;
  esac
  case "$dir" in
    /|/root|/home|/Users|/tmp|"$HOME"|"$HOME/")
      echo "[abort] refusing to rm -rf a root-level / home path: $dir" >&2
      exit 2
      ;;
  esac
  if [[ "$dir" != "$HOME"/* ]]; then
    echo "[abort] SOCRATIC_STATE_DIR must live under \$HOME ($HOME), got: $dir" >&2
    exit 2
  fi
  if [[ "$dir" != *".claude/socratic"* ]]; then
    echo "[abort] SOCRATIC_STATE_DIR must contain '.claude/socratic' segment, got: $dir" >&2
    exit 2
  fi
}

MODE=interactive
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --keep-state) MODE=keep ;;
    --purge)      MODE=purge ;;
    --dry-run)    DRY_RUN=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --- 1. purge hook entries -------------------------------------------------
if [[ ! -f "$SETTINGS_PATH" ]]; then
  echo "[note] no settings.json found at $SETTINGS_PATH — nothing to unhook."
else
  SOCRATIC_RE='socratiskill.*hook-(pre-prompt|post-turn)(-test)?\.sh'
  export SETTINGS_PATH SOCRATIC_RE DRY_RUN

  node -e '
    const fs = require("fs");
    const path = process.env.SETTINGS_PATH;
    let data = {};
    try { data = JSON.parse(fs.readFileSync(path, "utf-8")); } catch (e) { data = {}; }
    if (!data || typeof data !== "object") data = {};
    if (!data.hooks || typeof data.hooks !== "object") data.hooks = {};

    const re = new RegExp(process.env.SOCRATIC_RE);
    let removed = 0;

    function purge(event) {
      const arr = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
      const kept = [];
      for (const entry of arr) {
        const hooks = Array.isArray(entry && entry.hooks) ? entry.hooks : [];
        const hasOurs = hooks.some(h => h && typeof h.command === "string" && re.test(h.command));
        if (hasOurs) removed += 1;
        else kept.push(entry);
      }
      if (kept.length > 0) data.hooks[event] = kept;
      else delete data.hooks[event];
    }

    purge("UserPromptSubmit");
    purge("Stop");

    if (Object.keys(data.hooks).length === 0) delete data.hooks;

    const out = JSON.stringify(data, null, 2) + "\n";
    if (process.env.DRY_RUN === "1") {
      process.stdout.write("[dry-run] would remove " + removed + " hook entr(ies) from " + path + "\n");
      process.stdout.write(out);
    } else {
      fs.writeFileSync(path, out);
      process.stdout.write("[ok] removed " + removed + " hook entr(ies) from " + path + "\n");
    }
  '
fi

# --- 2. state dir ----------------------------------------------------------
if [[ -d "$STATE_DIR" ]]; then
  case "$MODE" in
    keep)
      echo "[keep] preserving $STATE_DIR (journal, profile, error-map)."
      ;;
    purge)
      if [[ "$DRY_RUN" == "1" ]]; then
        echo "[dry-run] would remove $STATE_DIR"
      else
        assert_safe_state_dir "$STATE_DIR"
        rm -rf -- "$STATE_DIR"
        echo "[ok] removed $STATE_DIR"
      fi
      ;;
    interactive)
      if [[ "$DRY_RUN" == "1" ]]; then
        echo "[dry-run] would prompt about removing $STATE_DIR"
      else
        printf 'Remove user state at %s? (profile, journal, error-map, sessions) [y/N] ' "$STATE_DIR"
        read -r ans || ans=""
        if [[ "$ans" == "y" || "$ans" == "Y" ]]; then
          assert_safe_state_dir "$STATE_DIR"
          rm -rf -- "$STATE_DIR"
          echo "[ok] removed $STATE_DIR"
        else
          echo "[keep] preserving $STATE_DIR"
        fi
      fi
      ;;
  esac
else
  echo "[note] no state dir at $STATE_DIR"
fi

echo ""
echo "[done] hooks removed. The plugin itself remains registered in"
echo "Claude Code — uninstall via: /plugin uninstall socratiskill"
