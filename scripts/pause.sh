#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill — pause.sh
#
# True bypass of the plugin without uninstalling. Renames
# ~/.claude/socratic/profile.json → profile.json.paused so that the
# UserPromptSubmit hook reads "no profile" and exits silently before
# generating any SOCRATIC CONTEXT (zero token cost per turn, ~5ms).
#
# Difference vs `/socratiskill:socratic off`:
#   - off  → enabled=false; hook still injects a ~30-token DISABLED
#            silencer message every turn.
#   - pause → no profile visible; hook short-circuits before any output.
#
# Use pause when you want the plugin truly invisible for a stretch of
# work without losing your level / streak / error-map. Use resume.sh
# (or /socratiskill:socratic resume) to come back exactly where you
# were.
#
# Usage:
#   bash pause.sh              # rename profile.json → profile.json.paused
#   bash pause.sh --dry-run    # show what would happen
#
# Env:
#   SOCRATIC_STATE_DIR   override state dir (defaults to ~/.claude/socratic)
#
# Exit codes:
#   0  paused successfully OR already paused (idempotent) OR no profile
#   2  invalid flag
# ---------------------------------------------------------------------------
set -euo pipefail

STATE_DIR="${SOCRATIC_STATE_DIR:-$HOME/.claude/socratic}"
PROFILE="$STATE_DIR/profile.json"
PAUSED="$STATE_DIR/profile.json.paused"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ -f "$PAUSED" && -f "$PROFILE" ]]; then
  # Defensive: both files exist. Do not silently overwrite — the user
  # may have a stale .paused from a prior interrupted cycle and an
  # active profile they care about. Refuse and let them sort it out.
  echo "[abort] both $PROFILE and $PAUSED exist." >&2
  echo "        the .paused file is from a prior pause that was never resumed." >&2
  echo "        decide which to keep, delete the other, then run again." >&2
  exit 2
fi

if [[ -f "$PAUSED" && ! -f "$PROFILE" ]]; then
  echo "[noop] already paused — $PAUSED exists, profile is hidden."
  echo "       run resume.sh (or /socratiskill:socratic resume) to reactivate."
  exit 0
fi

if [[ ! -f "$PROFILE" ]]; then
  echo "[noop] no profile to pause — $PROFILE does not exist."
  echo "       (run /socratiskill:socratic calibrate to create one if you want to use the plugin.)"
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] would rename $PROFILE → $PAUSED"
  exit 0
fi

# Atomic rename within the same directory. After this, the hook reads
# the state dir, finds no profile, and exits silently with zero stdout.
mv -- "$PROFILE" "$PAUSED"
echo "[paused] $PROFILE → $PAUSED"
echo "         hook will short-circuit on next turn (zero token cost)."
echo "         run /socratiskill:socratic resume (or scripts/resume.sh) to reactivate."
