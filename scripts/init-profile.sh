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

mkdir -p "${SOCRATIC_DIR}"

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
