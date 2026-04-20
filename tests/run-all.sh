#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Socratiskill — synthetic end-to-end test harness.
#
# Exercises every script and every interesting state transition in
# isolated temp dirs. Intended to run from CI or a fresh clone and
# validate that the plugin is behavior-equivalent to a known-good build
# before release.
#
# Usage:
#   bash tests/run-all.sh                 # run everything
#   bash tests/run-all.sh --only <N>      # run only scenario N (1..18)
#   bash tests/run-all.sh --list          # list scenarios
#   bash tests/run-all.sh --stop-on-fail  # abort on first FAIL
#
# Exit codes: 0 all pass, 1 at least one fail.
# ---------------------------------------------------------------------------
set -uo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PLUGIN_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
SCRIPTS="${PLUGIN_DIR}/scripts"

# --- output helpers --------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0
FAILED_TESTS=()
STOP_ON_FAIL=0
ONLY=""

for arg in "$@"; do
  case "$arg" in
    --stop-on-fail) STOP_ON_FAIL=1 ;;
    --only) shift; ONLY="${1:-}"; shift || true ;;
    --list) LIST_MODE=1 ;;
    --help|-h) sed -n '1,20p' "$0"; exit 0 ;;
  esac
done

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() {
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
  FAIL_COUNT=$((FAIL_COUNT+1))
  FAILED_TESTS+=("$1")
  if [[ "$STOP_ON_FAIL" == "1" ]]; then
    summary
    exit 1
  fi
}
header() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

summary() {
  echo ""
  echo "====================================================="
  echo "   PASSED: $PASS_COUNT"
  echo "   FAILED: $FAIL_COUNT"
  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    echo ""
    echo "   Failed tests:"
    for t in "${FAILED_TESTS[@]}"; do echo "     - $t"; done
  fi
  echo "====================================================="
}

# --- test isolation -------------------------------------------------------
# Root for every test's scratch state. `mktemp` avoids the old hardcoded
# "C:/temp/skstate" and cross-run collisions, but on Git Bash for Windows
# its output is a POSIX-style path like "/tmp/xxx" that native Windows
# binaries (bun, node when we spawn them) cannot resolve when they see
# it embedded as a literal in stdin/JSON — only env vars get the
# translation. So we normalize to a mixed Windows path via cygpath when
# available; on macOS/Linux the mktemp path is already fine.
TEST_ROOT="$(mktemp -d -t sktest.XXXXXXXX)"
if command -v cygpath >/dev/null 2>&1; then
  TEST_ROOT="$(cygpath -m "$TEST_ROOT")"
fi
trap 'rm -rf "$TEST_ROOT" 2>/dev/null || true' EXIT

setup_state() {
  local id="$1"
  local tmp="${TEST_ROOT}/state-${id}"
  mkdir -p "$tmp/sessions"
  cat > "$tmp/profile.json" <<'EOF'
{
  "global_level": 3,
  "mode": "learn",
  "comprehension_speed": 0.5,
  "copy_tendency": 0.5,
  "streak_days": 0,
  "calibration_completed": true,
  "last_active": null
}
EOF
  echo "$tmp"
}

teardown_state() { rm -rf "$1" 2>/dev/null || true; }

# Simulate a Stop hook invocation with a minimal transcript.
# The caller passes literal \n sequences for readability; we convert them to
# real newlines before writing the JSONL so the downstream parsers and
# regex-based code-block extractor see real line breaks (as they would in
# production transcripts).
fire_stop() {
  local tmp="$1"; local user="$2"; local agent="$3"
  local tr="$tmp/t.jsonl"
  node -e '
    const fs=require("fs");
    const interp = s => s.replace(/\\n/g, "\n");
    const u = interp(process.argv[2]);
    const a = interp(process.argv[3]);
    fs.writeFileSync(process.argv[1],
      JSON.stringify({type:"user", message:{content:u}}) + "\n" +
      JSON.stringify({type:"assistant", message:{content:a}}) + "\n");
  ' "$tr" "$user" "$agent"
  SOCRATIC_STATE_DIR="$tmp" SOCRATIC_DEBUG=1 bash "$SCRIPTS/hook-post-turn.sh" <<EOF
{"session_id":"s","transcript_path":"$tr","hook_event_name":"Stop"}
EOF
}

# Simulate a UserPromptSubmit hook invocation, return stdout.
fire_pre() {
  local tmp="$1"; local prompt="$2"
  SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/hook-pre-prompt.sh" <<EOF
{"prompt":"$prompt","hook_event_name":"UserPromptSubmit"}
EOF
}

should_run() {
  [[ -z "$ONLY" || "$ONLY" == "$1" ]]
}

list_scenarios() {
  grep -E '^## S[0-9]+ ' "$0" | sed 's/^## //'
}

if [[ "${LIST_MODE:-0}" == "1" ]]; then list_scenarios; exit 0; fi

# ==========================================================================
# SCENARIOS
# ==========================================================================

## S1 init-profile idempotent
if should_run 1; then
  header "S1 init-profile idempotent"
  tmp=$(setup_state 1)
  rm "$tmp/profile.json"
  SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/init-profile.sh" > /dev/null
  [[ -f "$tmp/profile.json" ]] && pass "profile.json created" || fail "S1a profile.json not created"
  # Re-run should not overwrite
  node -e 'const fs=require("fs"); const p=process.argv[1]; const x=JSON.parse(fs.readFileSync(p,"utf-8")); x.custom="marker"; fs.writeFileSync(p, JSON.stringify(x))' "$tmp/profile.json"
  SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/init-profile.sh" > /dev/null
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit(d.custom==="marker"?0:1)' "$tmp/profile.json" && pass "re-run preserves user data" || fail "S1b re-run wiped custom field"
  teardown_state "$tmp"
fi

## S2 commit-calibration writes level + timestamp
if should_run 2; then
  header "S2 commit-calibration"
  tmp=$(setup_state 2)
  SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/commit-calibration.sh" --level 4 > /dev/null
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit((d.global_level===4 && d.calibration_completed===true && d.calibration_date)?0:1)' "$tmp/profile.json" && pass "level=4 + calibrated + date" || fail "S2a state wrong"
  SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/commit-calibration.sh" --level 7 2>/dev/null && fail "S2b accepted level 7" || pass "rejects level 7"
  teardown_state "$tmp"
fi

## S3 detector + taxonomy pure functions
if should_run 3; then
  header "S3 detector + taxonomy"
  ZK=$(echo '{"prompt":"no se como usar useState"}' | SOCRATIC_STATE_DIR="$(setup_state 3)" bash "$SCRIPTS/hook-pre-prompt.sh" | grep -c "zero-knowledge")
  [[ "$ZK" -ge 1 ]] && pass "zero-knowledge detected" || fail "S3a zk not detected"
  SLOW=$(echo '{"prompt":"mas despacio por favor"}' | SOCRATIC_STATE_DIR="$(setup_state 3b)" bash "$SCRIPTS/hook-pre-prompt.sh" | grep -c "slow-down")
  [[ "$SLOW" -ge 1 ]] && pass "slow-down detected" || fail "S3b slow not detected"
  DOMAIN=$(echo '{"prompt":"react hooks useEffect useState component"}' | SOCRATIC_STATE_DIR="$(setup_state 3c)" bash "$SCRIPTS/hook-pre-prompt.sh" | grep "^domain:" | head -1)
  [[ "$DOMAIN" == *"web"* ]] && pass "web domain detected" || fail "S3c domain=$DOMAIN"
fi

## S4 hint-state transitions
if should_run 4; then
  header "S4 hint-state"
  tmp=$(setup_state 4)
  # fail twice -> should ascend once (from 0 to 1)
  fire_stop "$tmp" "q" "a\n\n<!-- HINT_META {\"topic\":\"t1\",\"correct\":false,\"domain\":\"web\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  fire_stop "$tmp" "q" "a\n\n<!-- HINT_META {\"topic\":\"t1\",\"correct\":false,\"domain\":\"web\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  HL=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]+"/sessions/"+new Date().toISOString().slice(0,10)+".json","utf-8")); console.log(d.hint_state.currentLevel)' "$tmp")
  [[ "$HL" == "1" ]] && pass "hint ascended after 2 fails (level=$HL)" || fail "S4a hint didn't ascend (got $HL)"
  teardown_state "$tmp"
fi

## S5 antipatterns activation at 3
if should_run 5; then
  header "S5 antipatterns activation"
  tmp=$(setup_state 5)
  for i in 1 2 3; do
    fire_stop "$tmp" "q$i" "code:\n\`\`\`js\nif (x == $i) y++;\n\`\`\`\n<!-- HINT_META {\"topic\":\"t\",\"correct\":null,\"domain\":\"web\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  ACT=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]+"/antipatterns.json","utf-8")); process.exit(d["js-loose-eq"].active===true && d["js-loose-eq"].occurrence_count===3 ? 0 : 1)' "$tmp" && echo ok || echo no)
  [[ "$ACT" == "ok" ]] && pass "js-loose-eq active after 3 occurrences" || fail "S5a not active"
  teardown_state "$tmp"
fi

## S6 antipatterns deactivation after 5 clean
if should_run 6; then
  header "S6 antipatterns deactivation"
  tmp=$(setup_state 6)
  for i in 1 2 3; do
    fire_stop "$tmp" "q" "\`\`\`js\nif (x == $i) y++;\n\`\`\`\n<!-- HINT_META {\"topic\":\"t\",\"correct\":null,\"domain\":\"web\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  for i in 1 2 3 4 5; do
    fire_stop "$tmp" "q" "\`\`\`js\nconst x=$i; if (x === 1) return;\n\`\`\`\n<!-- HINT_META {\"topic\":\"t\",\"correct\":null,\"domain\":\"web\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  DEACT=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]+"/antipatterns.json","utf-8")); process.exit(d["js-loose-eq"].active===false && d["js-loose-eq"].consecutive_clean===5 ? 0 : 1)' "$tmp" && echo ok || echo no)
  [[ "$DEACT" == "ok" ]] && pass "deactivated after 5 clean (count preserved)" || fail "S6a not deactivated"
  teardown_state "$tmp"
fi

## S7 loose-eq regex false-positive guard
if should_run 7; then
  header "S7 regex discriminates == from ==="
  tmp=$(setup_state 7)
  for i in 1 2 3 4 5; do
    fire_stop "$tmp" "q" "\`\`\`js\nif (a === b && c !== d && e <= f && g >= h) return;\n\`\`\`\n<!-- HINT_META {\"topic\":\"t\",\"correct\":null,\"domain\":\"web\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  COUNT=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]+"/antipatterns.json","utf-8")); console.log(d["js-loose-eq"]?.occurrence_count ?? 0)' "$tmp")
  [[ "$COUNT" == "0" ]] && pass "=== !== <= >= NOT matched as loose-eq" || fail "S7a false positive count=$COUNT"
  teardown_state "$tmp"
fi

## S8 HINT_META HTML comment extraction
if should_run 8; then
  header "S8 HINT_META new format"
  tmp=$(setup_state 8)
  fire_stop "$tmp" "q" "response\n\n<!-- HINT_META {\"topic\":\"newfmt\",\"correct\":true,\"domain\":\"web\",\"hintLevel\":2} /HINT_META -->"
  TOPIC=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]+"/sessions/"+new Date().toISOString().slice(0,10)+".json","utf-8")); console.log(d.turns[0]?.topic)' "$tmp")
  [[ "$TOPIC" == "newfmt" ]] && pass "comment-form extracted" || fail "S8a topic=$TOPIC"
  teardown_state "$tmp"
fi

## S9 HINT_META legacy bracket format still works
if should_run 9; then
  header "S9 HINT_META legacy format"
  tmp=$(setup_state 9)
  fire_stop "$tmp" "q" "response\n\n[HINT_META]\n{\"topic\":\"legacy\",\"correct\":false,\"domain\":\"web\",\"hintLevel\":3}\n[/HINT_META]"
  TOPIC=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]+"/sessions/"+new Date().toISOString().slice(0,10)+".json","utf-8")); console.log(d.turns[0]?.topic)' "$tmp")
  [[ "$TOPIC" == "legacy" ]] && pass "bracket-form still extracted (backwards compat)" || fail "S9a topic=$TOPIC"
  teardown_state "$tmp"
fi

## S10 Feynman cycle: teach → gap → endteach
if should_run 10; then
  header "S10 Feynman cycle"
  tmp=$(setup_state 10)
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/start-teach.ts" --topic "closures" > /dev/null || { fail "S10a start-teach failed"; teardown_state "$tmp"; }
  fire_stop "$tmp" "my explanation" "probing question\n<!-- HINT_META {\"topic\":\"closures\",\"correct\":null,\"domain\":\"lenguajes\",\"hintLevel\":0,\"feynman_gap\":\"missing cleanup\"} /HINT_META -->" > /dev/null
  GAPS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]+"/sessions/"+new Date().toISOString().slice(0,10)+".json","utf-8")); console.log(d.feynman?.gaps?.length ?? 0)' "$tmp")
  [[ "$GAPS" == "1" ]] && pass "gap captured during teach" || fail "S10b gaps=$GAPS"
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/end-teach.ts")
  echo "$OUT" | grep -q "1 gaps" && pass "endteach reports 1 gap" || fail "S10c: $OUT"
  HAS_SUMM=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]+"/sessions/"+new Date().toISOString().slice(0,10)+".json","utf-8")); process.exit(d.feynman_summaries?.length===1 && !d.feynman ? 0 : 1)' "$tmp" && echo ok || echo no)
  [[ "$HAS_SUMM" == "ok" ]] && pass "feynman moved to summaries" || fail "S10d summary not moved"
  teardown_state "$tmp"
fi

## S11 Feynman: double start rejected
if should_run 11; then
  header "S11 Feynman double-start"
  tmp=$(setup_state 11)
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/start-teach.ts" --topic "a" > /dev/null
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/start-teach.ts" --topic "b" 2>/dev/null && fail "S11a accepted double start" || pass "rejects second start while active"
  teardown_state "$tmp"
fi

## S12 Review/Leitner full progression
if should_run 12; then
  header "S12 Review/Leitner cycle"
  tmp=$(setup_state 12)
  node -e 'const fs=require("fs"); const past=new Date(Date.now()-48*3600000).toISOString(); fs.writeFileSync(process.argv[1], JSON.stringify({"t::web":{topic:"t",domain:"web",fail_count:2,success_count:0,consecutive_correct:0,last_hint_level:0,resolved:false,leitner_box:0,last_seen:past,next_review_at:past}}));' "$tmp/error-map.json"
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/pick-review.ts")
  echo "$OUT" | grep -q "review card found" && pass "pick-review finds due card" || fail "S12a pick-review miss"
  # Wrong answer
  fire_stop "$tmp" "a" "explanation\n<!-- HINT_META {\"topic\":\"t\",\"correct\":false,\"domain\":\"web\",\"hintLevel\":3} /HINT_META -->" > /dev/null
  RES=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]+"/error-map.json","utf-8"))["t::web"]; console.log(m.fail_count+"/"+m.leitner_box)' "$tmp")
  [[ "$RES" == "3/0" ]] && pass "wrong: fails=3 box=0" || fail "S12b got $RES"
  # Right x2
  fire_stop "$tmp" "a" "\n<!-- HINT_META {\"topic\":\"t\",\"correct\":true,\"domain\":\"web\",\"hintLevel\":2} /HINT_META -->" > /dev/null
  fire_stop "$tmp" "a" "\n<!-- HINT_META {\"topic\":\"t\",\"correct\":true,\"domain\":\"web\",\"hintLevel\":1} /HINT_META -->" > /dev/null
  RES=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]+"/error-map.json","utf-8"))["t::web"]; console.log(m.leitner_box+"/"+m.consecutive_correct)' "$tmp")
  [[ "$RES" == "1/2" ]] && pass "2 correct → box advances (box=1 consec=2)" || fail "S12c got $RES"
  teardown_state "$tmp"
fi

## S13 journal today/week/month
if should_run 13; then
  header "S13 journal generator"
  tmp=$(setup_state 13)
  TODAY=$(date -u +%Y-%m-%d)
  node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({date:process.argv[2],turns:[{ts:"x",session_id:"s",turn_index:0,topic:"r",correct:true,hint_level:1,user_level:3,domain:"web",user_excerpt:"q",agent_excerpt:"a"},{ts:"x",session_id:"s",turn_index:1,topic:"c",correct:false,hint_level:3,user_level:3,domain:"lenguajes",user_excerpt:"q",agent_excerpt:"a"}]}));' "$tmp/sessions/$TODAY.json" "$TODAY"
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/build-journal.ts" --period today)
  echo "$OUT" | grep -q "Learned" && echo "$OUT" | grep -q "Struggled" && pass "daily has Learned + Struggled sections" || fail "S13a sections missing"
  [[ -f "$tmp/journal/daily-$TODAY.md" ]] && pass "daily file written" || fail "S13b no file"
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/build-journal.ts" --period week > /dev/null
  ls "$tmp/journal/" | grep -q "weekly-" && pass "weekly file written" || fail "S13c no weekly"
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/build-journal.ts" --period month > /dev/null
  ls "$tmp/journal/" | grep -q "monthly-" && pass "monthly file written" || fail "S13d no monthly"
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/build-journal.ts" --period daily 2>/dev/null && fail "S13e accepted bad period" || pass "rejects invalid period"
  teardown_state "$tmp"
fi

## S14 enabled=false kill switch
if should_run 14; then
  header "S14 enabled flag toggle"
  tmp=$(setup_state 14)
  node -e 'const fs=require("fs"); const p=process.argv[1]; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.enabled=false; fs.writeFileSync(p, JSON.stringify(d,null,2))' "$tmp/profile.json"

  OUT=$(fire_pre "$tmp" "hello")
  # When disabled, the hook must emit an explicit "DISABLED" override
  # instead of staying silent — silence isn't enough because the plugin's
  # commands stay registered and the model still perceives the plugin.
  echo "$OUT" | grep -q "SOCRATIC CONTEXT: DISABLED" && pass "disabled: emits DISABLED silencer" || fail "S14a missing silencer"
  echo "$OUT" | grep -q "Behave exactly as default Claude Code" && pass "disabled: tells model to behave as default" || fail "S14a-2 missing behave-default instruction"
  # The silencer mentions HINT_META once (to tell the model NOT to emit
  # it) but must not include the actual META PROTOCOL header that would
  # request the telemetry block.
  echo "$OUT" | grep -q "META PROTOCOL (required)" && fail "S14a-3 silencer leaked META PROTOCOL header" || pass "disabled: no META PROTOCOL header"

  fire_stop "$tmp" "q" "a\n<!-- HINT_META {\"topic\":\"blocked\",\"correct\":true,\"domain\":\"web\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  TODAY=$(date -u +%Y-%m-%d)
  [[ ! -f "$tmp/sessions/$TODAY.json" ]] && pass "disabled: no session file written" || fail "S14b file written"

  # Re-enable
  node -e 'const fs=require("fs"); const p=process.argv[1]; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.enabled=true; fs.writeFileSync(p, JSON.stringify(d,null,2))' "$tmp/profile.json"
  OUT=$(fire_pre "$tmp" "hello")
  echo "$OUT" | head -1 | grep -q "^SOCRATIC CONTEXT$" && pass "enabled=true restores full injection" || fail "S14c no context after re-enable"
  teardown_state "$tmp"
fi

## S15 challenge flag one-shot
if should_run 15; then
  header "S15 challenge flag consumed once"
  tmp=$(setup_state 15)
  node -e 'const fs=require("fs"); const p=process.argv[1]; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.challenge_next_turn=true; fs.writeFileSync(p, JSON.stringify(d,null,2))' "$tmp/profile.json"
  OUT1=$(fire_pre "$tmp" "q")
  echo "$OUT1" | grep -q "challenge: ACTIVE" && pass "first turn: challenge active" || fail "S15a no challenge"
  OUT2=$(fire_pre "$tmp" "q")
  echo "$OUT2" | grep -q "challenge: ACTIVE" && fail "S15b challenge not consumed" || pass "second turn: challenge consumed"
  teardown_state "$tmp"
fi

## S16 install.sh idempotent
if should_run 16; then
  header "S16 install.sh fresh + idempotent"
  tmp=$(setup_state 16)
  rm -f "$tmp/profile.json"
  CLAUDE_SETTINGS="$tmp/settings.json" SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/install.sh" > /dev/null
  [[ -f "$tmp/profile.json" ]] && pass "install creates profile" || fail "S16a no profile"
  CLAUDE_SETTINGS="$tmp/settings.json" SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/install.sh" > /dev/null
  UPS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); console.log(d.hooks.UserPromptSubmit.length)' "$tmp/settings.json")
  [[ "$UPS" == "1" ]] && pass "re-run doesn't duplicate (count=1)" || fail "S16b count=$UPS"
  teardown_state "$tmp"
fi

## S17 uninstall preserves other hooks
if should_run 17; then
  header "S17 uninstall preserves unrelated hooks"
  tmp=$(setup_state 17)
  cat > "$tmp/settings.json" <<'EOF'
{
  "permissions": {"allow":["Bash(ls:*)"]},
  "hooks": {
    "UserPromptSubmit": [{"hooks":[{"type":"command","command":"bash /other/hook.sh"}]}],
    "PreToolUse": [{"hooks":[{"type":"command","command":"echo other"}]}]
  }
}
EOF
  CLAUDE_SETTINGS="$tmp/settings.json" SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/install.sh" > /dev/null
  CLAUDE_SETTINGS="$tmp/settings.json" SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/uninstall.sh" --keep-state > /dev/null
  KEPT=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); const other=d.hooks?.UserPromptSubmit?.some(e=>e.hooks.some(h=>h.command.includes("/other/"))); const ours=d.hooks?.UserPromptSubmit?.some(e=>e.hooks.some(h=>h.command.includes("socratiskill"))); const pre=d.hooks?.PreToolUse?.length>=1; const perms=d.permissions?.allow?.[0]==="Bash(ls:*)"; console.log(JSON.stringify({other,ours:!!ours,pre,perms}))' "$tmp/settings.json")
  echo "$KEPT" | grep -q '"other":true' && pass "other UserPromptSubmit kept" || fail "S17a other: $KEPT"
  echo "$KEPT" | grep -q '"ours":false' && pass "ours removed" || fail "S17b ours still: $KEPT"
  echo "$KEPT" | grep -q '"pre":true' && pass "PreToolUse kept" || fail "S17c pre: $KEPT"
  echo "$KEPT" | grep -q '"perms":true' && pass "permissions kept" || fail "S17d perms: $KEPT"
  teardown_state "$tmp"
fi

## S18 build-context wiring: all features at once
if should_run 18; then
  header "S18 build-context end-to-end with all features"
  tmp=$(setup_state 18)
  TODAY=$(date -u +%Y-%m-%d)
  node -e 'const fs=require("fs"); const now=Date.now(); const past=new Date(now-48*3600000).toISOString(); fs.writeFileSync(process.argv[1], JSON.stringify({"due::web":{topic:"due",domain:"web",fail_count:2,success_count:0,consecutive_correct:0,last_hint_level:1,resolved:false,leitner_box:0,last_seen:past,next_review_at:past}}));' "$tmp/error-map.json"
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/start-teach.ts" --topic "closures" > /dev/null
  for i in 1 2 3; do
    fire_stop "$tmp" "q" "\`\`\`js\nif (x == $i) y++;\n\`\`\`\n<!-- HINT_META {\"topic\":\"t\",\"correct\":null,\"domain\":\"web\",\"hintLevel\":0,\"feynman_gap\":\"g$i\"} /HINT_META -->" > /dev/null
  done
  OUT=$(fire_pre "$tmp" "i don't know how this works")
  echo "$OUT" | grep -q "feynman: teaching" && pass "feynman line present" || fail "S18a no feynman"
  echo "$OUT" | grep -q "active antipatterns:" && pass "antipatterns line present" || fail "S18b no antipatterns"
  echo "$OUT" | grep -q "zero-knowledge=" && pass "zk signal present" || fail "S18c no zk"
  echo "$OUT" | grep -q "review due:" && pass "review due line present" || fail "S18d no review due"
  echo "$OUT" | grep -q "rules:.*feynman.md.*antipatterns.md" && pass "rules line has both extras" || fail "S18e rules missing extras"
  echo "$OUT" | grep -q "<!-- HINT_META" && pass "meta protocol uses HTML comment" || fail "S18f bracket form"
  teardown_state "$tmp"
fi

## S20 pause/resume cycle
if should_run 20; then
  header "S20 pause/resume cycle"
  tmp=$(setup_state 20)

  # 20a — pause renames profile to .paused
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/pause.sh" 2>&1)
  if [[ -f "$tmp/profile.json.paused" && ! -f "$tmp/profile.json" ]]; then
    pass "pause moves profile.json to profile.json.paused"
  else
    fail "S20a pause did not rename"
  fi

  # 20b — hook short-circuits silently while paused (no output, no silencer)
  OUT=$(fire_pre "$tmp" "hello while paused")
  if [[ -z "$OUT" ]]; then
    pass "hook emits zero stdout while paused"
  else
    fail "S20b hook leaked output while paused (got: $OUT)"
  fi

  # 20c — pause again is idempotent
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/pause.sh" 2>&1)
  echo "$OUT" | grep -q "already paused" && pass "second pause is idempotent" || fail "S20c second pause not idempotent"

  # 20d — resume restores
  SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/resume.sh" >/dev/null 2>&1
  if [[ -f "$tmp/profile.json" && ! -f "$tmp/profile.json.paused" ]]; then
    pass "resume restores profile.json"
  else
    fail "S20d resume did not restore"
  fi

  # 20e — hook injects SOCRATIC CONTEXT again after resume
  OUT=$(fire_pre "$tmp" "hello after resume")
  echo "$OUT" | head -1 | grep -q "^SOCRATIC CONTEXT$" && pass "hook resumes injection after resume" || fail "S20e no context after resume"

  # 20f — resume when not paused is idempotent
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/resume.sh" 2>&1)
  echo "$OUT" | grep -q "not paused" && pass "second resume is idempotent" || fail "S20f second resume not idempotent"

  # 20g — conflict: both files exist → resume must abort exit 1
  cp "$tmp/profile.json" "$tmp/profile.json.paused"
  set +e
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/resume.sh" 2>&1); EX=$?
  set -e
  if [[ "$EX" == "1" ]] && echo "$OUT" | grep -q "cannot resume"; then
    pass "resume aborts on conflict (exit 1)"
  else
    fail "S20g resume did not detect conflict (exit=$EX)"
  fi
  rm -f "$tmp/profile.json.paused"

  teardown_state "$tmp"
fi

## S19 level-1 hard-limits block is injected only when level=1
if should_run 19; then
  header "S19 level-1 hard-limits block (only at level 1)"
  tmp=$(setup_state 19)

  # 19a — at level 1, the CRITICAL block is present
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=1; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  OUT=$(fire_pre "$tmp" "implementame algo")
  echo "$OUT" | grep -q "LEVEL 1 HARD LIMITS" && pass "level=1 injects HARD LIMITS block" || fail "S19a missing HARD LIMITS at level 1"
  echo "$OUT" | grep -q "DO NOT call Write" && pass "block reminds about Write/Edit gate" || fail "S19b missing Write gate reminder"

  # 19b — at level 3, the block must NOT appear
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=3; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  OUT=$(fire_pre "$tmp" "implementame algo")
  echo "$OUT" | grep -q "LEVEL 1 HARD LIMITS" && fail "S19c HARD LIMITS leaked into level 3" || pass "level=3 does NOT inject HARD LIMITS block"

  teardown_state "$tmp"
fi

## S21 per-level calibration thresholds (novices need more evidence)
if should_run 21; then
  header "S21 per-level calibration thresholds"

  # 21a — at level 1, 5 correct turns must NOT trigger up-suggestion
  tmp=$(setup_state 21)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=1; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3 4 5; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"t$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.stdout.write(d.pending_calibration_change?"yes":"no")' "$tmp/profile.json")
  [[ "$HAS" == "no" ]] && pass "level=1 + 5 correct -> no premature up-suggestion" || fail "S21a level 1 pre-maturely suggested up at 5 correct"
  teardown_state "$tmp"

  # 21b — at level 1, 10 correct in a 12-turn window → must suggest up to 2
  tmp=$(setup_state 21)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=1; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"t$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); const p=d.pending_calibration_change; process.stdout.write(p && p.direction==="up" && p.from===1 && p.to===2 ? "yes" : "no")' "$tmp/profile.json")
  [[ "$HAS" == "yes" ]] && pass "level=1 + 10 correct -> suggests up to 2" || fail "S21b level 1 did not suggest up at 10 correct"
  teardown_state "$tmp"

  # 21c — at level 3, 5 correct DO trigger up (advanced rule: 5/7)
  tmp=$(setup_state 21)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=3; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3 4 5; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"t$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); const p=d.pending_calibration_change; process.stdout.write(p && p.direction==="up" && p.from===3 && p.to===4 ? "yes" : "no")' "$tmp/profile.json")
  [[ "$HAS" == "yes" ]] && pass "level=3 + 5 correct -> suggests up to 4" || fail "S21c level 3 did not suggest up at 5 correct"
  teardown_state "$tmp"

  # 21d — fast downgrade preserved: 3 wrong at level 3 → suggests down to 2
  tmp=$(setup_state 21)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=3; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"t$i\",\"correct\":false,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); const p=d.pending_calibration_change; process.stdout.write(p && p.direction==="down" && p.from===3 && p.to===2 ? "yes" : "no")' "$tmp/profile.json")
  [[ "$HAS" == "yes" ]] && pass "level=3 + 3 wrong -> fast downgrade to 2" || fail "S21d level 3 did not downgrade at 3 wrong"
  teardown_state "$tmp"
fi

# ==========================================================================
summary
[[ "$FAIL_COUNT" -eq 0 ]]
