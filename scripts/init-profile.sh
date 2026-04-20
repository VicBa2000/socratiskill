#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill / FASE 1 - Tarea 1.4
# init-profile.sh - Idempotent initializer for ~/.claude/socratic/profile.json
#
# Behavior:
#   - Creates ~/.claude/socratic/ if it does not exist.
#   - If profile.json already exists, DO NOT overwrite. Prints its summary.
#   - If it does not exist, writes the default profile and prints a summary.
#
# Exits 0 on success (both paths), non-zero only on filesystem errors.
# ---------------------------------------------------------------------------
set -euo pipefail

SOCRATIC_DIR="${SOCRATIC_STATE_DIR:-$HOME/.claude/socratic}"
PROFILE_PATH="${SOCRATIC_DIR}/profile.json"
PAUSED_PATH="${SOCRATIC_DIR}/profile.json.paused"

mkdir -p "${SOCRATIC_DIR}"

# Guard: if profile.json is missing but profile.json.paused exists, the
# plugin is currently paused. Creating a default profile.json here would
# produce two profiles on disk and make resume.sh refuse with "both files
# exist". Refuse loudly instead — the user must either resume or
# explicitly discard the paused state first.
if [[ ! -f "${PROFILE_PATH}" && -f "${PAUSED_PATH}" ]]; then
  echo "[abort] plugin is PAUSED — cannot create a new default profile." >&2
  echo "        profile.json is missing but profile.json.paused exists at:" >&2
  echo "          ${PAUSED_PATH}" >&2
  echo "" >&2
  echo "        run ONE of these before retrying:" >&2
  echo "          /socratiskill:socratic resume       (restore the paused profile)" >&2
  echo "          bash scripts/resume.sh              (same, shell equivalent)" >&2
  echo "" >&2
  echo "        or, to discard the paused state and start fresh:" >&2
  echo "          rm ${PAUSED_PATH}" >&2
  exit 3
fi

if [[ -f "${PROFILE_PATH}" ]]; then
  echo "profile: EXISTS at ${PROFILE_PATH}"
  # Use node to validate + pretty-print summary; no jq dependency.
  node -e "
    const fs = require('fs');
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      console.log('  level:      ' + (p.global_level ?? '?'));
      console.log('  mode:       ' + (p.mode ?? '?'));
      console.log('  calibrated: ' + (p.calibration_completed ?? false));
    } catch (e) {
      console.error('  ERROR: profile.json is not valid JSON: ' + e.message);
      process.exit(2);
    }
  " "${PROFILE_PATH}"
  exit 0
fi

# Not existing - write defaults.
cat > "${PROFILE_PATH}" <<'EOF'
{
  "global_level": 3,
  "mode": "learn",
  "comprehension_speed": 0.5,
  "copy_tendency": 0.5,
  "streak_days": 0,
  "calibration_completed": false,
  "last_active": null
}
EOF

echo "profile: CREATED at ${PROFILE_PATH}"
echo "  level:      3 (Intermediate / Pair programmer)"
echo "  mode:       learn"
echo "  calibrated: false"
echo ""
echo "next step: run /socratiskill:socratic calibrate (FASE 2) to personalize."
