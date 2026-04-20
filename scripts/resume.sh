#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill — resume.sh
#
# Reverse of pause.sh. Renames profile.json.paused → profile.json so the
# UserPromptSubmit hook starts injecting SOCRATIC CONTEXT again on the
# next turn.
#
# Usage:
#   bash resume.sh             # rename profile.json.paused → profile.json
#   bash resume.sh --dry-run
#
# Env:
#   SOCRATIC_STATE_DIR   override state dir (defaults to ~/.claude/socratic)
#
# Exit codes:
#   0  resumed successfully OR was not paused (idempotent)
#   1  conflict: both profile.json and profile.json.paused exist
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

if [[ ! -f "$PAUSED" && ! -f "$PROFILE" ]]; then
  echo "[noop] not paused and no active profile — nothing to do."
  echo "       (run /socratiskill:socratic calibrate to create a profile.)"
  exit 0
fi

if [[ ! -f "$PAUSED" && -f "$PROFILE" ]]; then
  echo "[noop] not paused — $PROFILE is already active."
  exit 0
fi

if [[ -f "$PAUSED" && -f "$PROFILE" ]]; then
  # Conflict: someone created (or recalibrated) a profile while paused.
  # We refuse to overwrite either side because both may contain data
  # the user cares about.
  echo "[abort] cannot resume: both $PROFILE and $PAUSED exist." >&2
  echo "        the active profile may have been recreated since pause." >&2
  echo "        keep one and delete the other manually:" >&2
  echo "          - keep current state, discard paused: rm $PAUSED" >&2
  echo "          - restore paused state, discard current: rm $PROFILE && mv $PAUSED $PROFILE" >&2
  exit 1
fi

# Only $PAUSED exists at this point.
if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] would rename $PAUSED → $PROFILE"
  exit 0
fi

mv -- "$PAUSED" "$PROFILE"
echo "[resumed] $PAUSED → $PROFILE"
echo "          hook will inject SOCRATIC CONTEXT on next turn."
