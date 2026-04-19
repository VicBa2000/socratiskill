#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill / FASE 2 - Tarea 2.3
# commit-calibration.sh - Commit the calibration result to profile.json.
#
# Usage:
#   commit-calibration.sh --level <1-5>
#
# Behavior:
#   - Reads ~/.claude/socratic/profile.json.
#   - Updates: global_level=N, calibration_completed=true,
#              calibration_date=<ISO 8601 UTC>.
#   - Preserves every other field.
#   - If profile.json does not exist, creates the default skeleton then
#     applies the update (init-profile.sh is called first internally).
#
# Exits 0 on success, non-zero on invalid input or filesystem error.
# ---------------------------------------------------------------------------
set -euo pipefail

SOCRATIC_DIR="${SOCRATIC_STATE_DIR:-$HOME/.claude/socratic}"
PROFILE_PATH="${SOCRATIC_DIR}/profile.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse args
LEVEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --level)
      LEVEL="$2"
      shift 2
      ;;
    *)
      echo "unknown arg: $1" >&2
      echo "usage: commit-calibration.sh --level <1-5>" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${LEVEL}" ]]; then
  echo "missing --level" >&2
  exit 2
fi

# Validate level is integer 1-5
if ! [[ "${LEVEL}" =~ ^[1-5]$ ]]; then
  echo "invalid level: ${LEVEL} (must be 1, 2, 3, 4, or 5)" >&2
  exit 2
fi

# Ensure profile exists (idempotent)
if [[ ! -f "${PROFILE_PATH}" ]]; then
  bash "${SCRIPT_DIR}/init-profile.sh" >/dev/null
fi

# Commit via node. Preserve all existing fields, update only the 3 targets.
node -e "
  const fs = require('fs');
  const path = process.argv[1];
  const level = parseInt(process.argv[2], 10);
  const p = JSON.parse(fs.readFileSync(path, 'utf8'));
  p.global_level = level;
  p.calibration_completed = true;
  p.calibration_date = new Date().toISOString();
  fs.writeFileSync(path, JSON.stringify(p, null, 2) + '\n');
  console.log('committed: level=' + level + ' at ' + p.calibration_date);
" "${PROFILE_PATH}" "${LEVEL}"
