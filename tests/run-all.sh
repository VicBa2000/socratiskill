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

# Session files are named by UTC date (the scripts use toISOString), so
# assertions must resolve the path with `date -u`. Using local time here
# passes all day and then fails for the hours when the two dates differ.

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

# Simulate a PreToolUse hook invocation and report the verdict as
# "allow" (hook printed nothing) or "deny" (hook printed a decision).
# For Bash the third argument is the command; for the write tools it is
# the file content.
gate_verdict() {
  local tmp="$1"; local tool="$2"; local payload="${3:-x}"
  local out
  out=$(node -e '
    const t=process.argv[1], c=process.argv[2];
    const input = t==="Bash" ? {command:c} : {file_path:"src/a.ts", content:c};
    process.stdout.write(JSON.stringify({tool_name:t, tool_input:input, hook_event_name:"PreToolUse"}));
  ' "$tool" "$payload" | SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/hook-pre-tool.sh")
  if [[ -z "$out" ]]; then echo "allow"; else echo "deny"; fi
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
  # setup_state defaults to global_level=3 -> getInitialHintLevel(3) = 2.
  # Two fails -> ascend once (2 -> 3). The test checks the ascension
  # mechanic; if getInitialHintLevel(3) changes again, update the literal.
  fire_stop "$tmp" "q" "a\n\n<!-- HINT_META {\"topic\":\"t1\",\"correct\":false,\"domain\":\"web\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  fire_stop "$tmp" "q" "a\n\n<!-- HINT_META {\"topic\":\"t1\",\"correct\":false,\"domain\":\"web\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  HL=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]+"/sessions/"+new Date().toISOString().slice(0,10)+".json","utf-8")); console.log(d.hint_state.currentLevel)' "$tmp")
  [[ "$HL" == "3" ]] && pass "hint ascended after 2 fails (level=$HL)" || fail "S4a hint didn't ascend (got $HL)"
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

  # 20b — first hook run after pause emits a one-shot PAUSED silencer...
  OUT=$(fire_pre "$tmp" "hello right after pause")
  echo "$OUT" | head -1 | grep -q "^SOCRATIC CONTEXT: PAUSED" && pass "first hook after pause emits one-shot silencer" || fail "S20b first post-pause hook did not emit silencer (got: $OUT)"

  # 20b2 — ...and subsequent runs are fully silent (zero token cost)
  OUT=$(fire_pre "$tmp" "hello later while paused")
  [[ -z "$OUT" ]] && pass "subsequent hooks after pause are silent" || fail "S20b2 hook leaked on 2nd call while paused (got: $OUT)"

  # 20b3 — the one-shot marker was consumed (file deleted)
  [[ ! -f "$tmp/.pause-silencer-pending" ]] && pass "silencer marker consumed after 1 use" || fail "S20b3 silencer marker not deleted"

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
  # errexit is OFF for the whole harness (see the header): scenarios assert
  # on exit codes, so a non-zero status is data, not a crash. Do NOT "restore"
  # it with `set -e` here — that switches errexit ON for every scenario that
  # follows, and the next one that expects a failure dies silently mid-run.
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/resume.sh" 2>&1); EX=$?
  if [[ "$EX" == "1" ]] && echo "$OUT" | grep -q "cannot resume"; then
    pass "resume aborts on conflict (exit 1)"
  else
    fail "S20g resume did not detect conflict (exit=$EX)"
  fi
  rm -f "$tmp/profile.json.paused"

  # 20h — resume without firing a hook still cleans the marker
  SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/pause.sh" >/dev/null 2>&1
  [[ -f "$tmp/.pause-silencer-pending" ]] || fail "S20h pause did not create marker for resume cleanup test"
  SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/resume.sh" >/dev/null 2>&1
  [[ ! -f "$tmp/.pause-silencer-pending" ]] && pass "resume cleans stale silencer marker" || fail "S20h resume left stale marker"

  teardown_state "$tmp"
fi

## S19 per-level protocol blocks (L1 hard-limits, L2/L3/L4 protocols, L5 silent)
if should_run 19; then
  header "S19 per-level protocol blocks (mode-sensitive)"

  set_profile() {
    # $1=tmp $2=level $3=mode
    node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=Number(process.argv[2]); d.mode=process.argv[3]; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$1" "$2" "$3"
  }

  # 19a — at level 1 (learn), HARD LIMITS block is present
  tmp=$(setup_state 19a); set_profile "$tmp" 1 learn
  OUT=$(fire_pre "$tmp" "implementame algo")
  echo "$OUT" | grep -q "LEVEL 1 HARD LIMITS" && pass "L1: HARD LIMITS block injected" || fail "S19a missing HARD LIMITS at level 1"
  echo "$OUT" | grep -q "DO NOT call Write" && pass "L1: block reminds about Write/Edit gate" || fail "S19a2 missing Write gate reminder"
  teardown_state "$tmp"

  # 19b — at level 2 (learn), L2 protocol present (learn flavor) + no L1 leak
  tmp=$(setup_state 19b); set_profile "$tmp" 2 learn
  OUT=$(fire_pre "$tmp" "dame una funcion que valide emails")
  echo "$OUT" | grep -q "LEVEL 2 PROTOCOL (learn" && pass "L2 learn: protocol block injected" || fail "S19b missing L2 learn block"
  echo "$OUT" | grep -q "state the WHY" && pass "L2 learn: requires WHY before non-trivial decisions" || fail "S19b2 L2 learn missing WHY rule"
  echo "$OUT" | grep -q "LEVEL 1 HARD LIMITS" && fail "S19b3 L1 block leaked into L2" || pass "L2: no L1 block leak"
  teardown_state "$tmp"

  # 19c — at level 2 (productive), shorter L2 productive block
  tmp=$(setup_state 19c); set_profile "$tmp" 2 productive
  OUT=$(fire_pre "$tmp" "dame una funcion que valide emails")
  echo "$OUT" | grep -q "LEVEL 2 PROTOCOL (productive" && pass "L2 productive: protocol block injected" || fail "S19c missing L2 productive block"
  echo "$OUT" | grep -q "LEVEL 2 PROTOCOL (learn" && fail "S19c2 L2 learn flavor leaked into productive" || pass "L2 productive: no learn-flavor leak"
  teardown_state "$tmp"

  # 19d — at level 3 (learn), L3 learn protocol + gapped code + "¿Qué enfoque"
  tmp=$(setup_state 19d); set_profile "$tmp" 3 learn
  OUT=$(fire_pre "$tmp" "implementame algo no trivial")
  echo "$OUT" | grep -q "LEVEL 3 PROTOCOL (learn" && pass "L3 learn: protocol block injected" || fail "S19d missing L3 learn block"
  echo "$OUT" | grep -q "¿Qué enfoque" && pass "L3 learn: asks for approach first" || fail "S19d2 L3 learn missing approach question"
  echo "$OUT" | grep -q "gapped code" && pass "L3 learn: requires gapped code" || fail "S19d3 L3 learn missing gapped code"
  echo "$OUT" | grep -q "LEVEL 1 HARD LIMITS" && fail "S19d4 L1 block leaked into L3" || pass "L3: no L1 block leak"
  teardown_state "$tmp"

  # 19e — at level 3 (productive), direct implementation, no gapped code
  tmp=$(setup_state 19e); set_profile "$tmp" 3 productive
  OUT=$(fire_pre "$tmp" "implementame algo no trivial")
  echo "$OUT" | grep -q "LEVEL 3 PROTOCOL (productive" && pass "L3 productive: protocol block injected" || fail "S19e missing L3 productive block"
  echo "$OUT" | grep -q "No gapped code" && pass "L3 productive: explicitly no gapped code" || fail "S19e2 L3 productive should disable gapped code"
  teardown_state "$tmp"

  # 19f — at level 4 (learn), challenge-as-question required
  tmp=$(setup_state 19f); set_profile "$tmp" 4 learn
  OUT=$(fire_pre "$tmp" "aqui esta mi propuesta de arquitectura")
  echo "$OUT" | grep -q "LEVEL 4 PROTOCOL (learn" && pass "L4 learn: protocol block injected" || fail "S19f missing L4 learn block"
  echo "$OUT" | grep -q "at least ONE concrete challenge" && pass "L4 learn: requires at least one challenge" || fail "S19f2 L4 learn missing challenge rule"
  teardown_state "$tmp"

  # 19g — at level 4 (productive), terse, critical-only
  tmp=$(setup_state 19g); set_profile "$tmp" 4 productive
  OUT=$(fire_pre "$tmp" "implementa esto")
  echo "$OUT" | grep -q "LEVEL 4 PROTOCOL (productive" && pass "L4 productive: protocol block injected" || fail "S19g missing L4 productive block"
  echo "$OUT" | grep -q "Flag ONLY the critical" && pass "L4 productive: critical-only flagging" || fail "S19g2 L4 productive missing critical-only rule"
  teardown_state "$tmp"

  # 19h — at level 5, NO protocol block (silent colleague)
  tmp=$(setup_state 19h); set_profile "$tmp" 5 learn
  OUT=$(fire_pre "$tmp" "implementa esto")
  echo "$OUT" | grep -qE "LEVEL [1-5] (HARD LIMITS|PROTOCOL)" && fail "S19h L5 unexpectedly got a protocol block" || pass "L5: no protocol block (silent colleague)"
  teardown_state "$tmp"
fi

## S22 init-profile refuses to create default while paused
if should_run 22; then
  header "S22 init-profile refuses when .paused exists"

  # 22a — paused state: profile.json absent, profile.json.paused present
  tmp=$(setup_state 22)
  mv "$tmp/profile.json" "$tmp/profile.json.paused"
  # errexit is OFF for the whole harness (see the header): scenarios assert
  # on exit codes, so a non-zero status is data, not a crash. Do NOT "restore"
  # it with `set -e` here — that switches errexit ON for every scenario that
  # follows, and the next one that expects a failure dies silently mid-run.
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/init-profile.sh" 2>&1); EX=$?
  if [[ "$EX" == "3" ]] && echo "$OUT" | grep -q "plugin is PAUSED"; then
    pass "init-profile refuses with exit 3 when .paused exists"
  else
    fail "S22a init-profile should refuse (exit=$EX, out=$OUT)"
  fi
  [[ ! -f "$tmp/profile.json" ]] && pass "profile.json was NOT created while paused" || fail "S22a2 profile.json wrongly created"
  teardown_state "$tmp"

  # 22b — commit-calibration also fails when paused (delegates to init)
  tmp=$(setup_state 22)
  mv "$tmp/profile.json" "$tmp/profile.json.paused"
  # errexit is OFF for the whole harness (see the header): scenarios assert
  # on exit codes, so a non-zero status is data, not a crash. Do NOT "restore"
  # it with `set -e` here — that switches errexit ON for every scenario that
  # follows, and the next one that expects a failure dies silently mid-run.
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/commit-calibration.sh" --level 3 2>&1); EX=$?
  if [[ "$EX" != "0" ]]; then
    pass "commit-calibration refuses while paused (exit=$EX)"
  else
    fail "S22b commit-calibration should have failed while paused"
  fi
  [[ ! -f "$tmp/profile.json" ]] && pass "profile.json was NOT created by calibrate while paused" || fail "S22b2 calibrate created duplicate profile"
  teardown_state "$tmp"

  # 22c — normal init (no .paused) still works
  tmp=$(setup_state 22)
  rm "$tmp/profile.json"
  SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/init-profile.sh" > /dev/null
  [[ -f "$tmp/profile.json" ]] && pass "init-profile works normally when no .paused" || fail "S22c init-profile broke the happy path"
  teardown_state "$tmp"
fi

## S21 per-level calibration thresholds + diagnostic gate
if should_run 21; then
  header "S21 per-level calibration thresholds + diagnostic gate"

  # 21a — at level 1, 5 correct turns must NOT trigger ANY pending
  tmp=$(setup_state 21)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=1; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3 4 5; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"t$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.stdout.write((d.pending_calibration_change||d.pending_diagnostic)?"yes":"no")' "$tmp/profile.json")
  [[ "$HAS" == "no" ]] && pass "level=1 + 5 correct -> no premature pending" || fail "S21a level 1 pre-maturely set pending at 5 correct"
  teardown_state "$tmp"

  # 21b — at level 1, 10 correct → enters DIAGNOSTIC (not direct promote)
  tmp=$(setup_state 21)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=1; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"t$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); const p=d.pending_diagnostic; const c=d.pending_calibration_change; process.stdout.write(p && p.target_level===2 && !c ? "yes" : "no")' "$tmp/profile.json")
  [[ "$HAS" == "yes" ]] && pass "level=1 + 10 correct -> enters diagnostic for L2" || fail "S21b level 1 did not enter diagnostic at 10 correct"
  teardown_state "$tmp"

  # 21c — diagnostic PASS (2/3 pass) → promotes to pending_calibration_change
  tmp=$(setup_state 21)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=3; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3 4 5; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"t$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  # now in diagnostic; answer 3 diagnostic turns: pass, pass, fail
  fire_stop "$tmp" "dq1" "da\n\n<!-- HINT_META {\"topic\":\"dt\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0,\"diagnostic\":\"pass\"} /HINT_META -->" > /dev/null
  fire_stop "$tmp" "dq2" "da\n\n<!-- HINT_META {\"topic\":\"dt\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0,\"diagnostic\":\"pass\"} /HINT_META -->" > /dev/null
  fire_stop "$tmp" "dq3" "da\n\n<!-- HINT_META {\"topic\":\"dt\",\"correct\":false,\"domain\":\"fundamentos\",\"hintLevel\":0,\"diagnostic\":\"fail\"} /HINT_META -->" > /dev/null
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); const c=d.pending_calibration_change; const p=d.pending_diagnostic; process.stdout.write(c && c.direction==="up" && c.to===4 && !p ? "yes" : "no")' "$tmp/profile.json")
  [[ "$HAS" == "yes" ]] && pass "diagnostic 2/3 pass -> promotes to pending_calibration_change" || fail "S21c diagnostic 2-of-3 did not promote"
  teardown_state "$tmp"

  # 21d — diagnostic FAIL (1/3 pass) → clears diagnostic, no promotion
  tmp=$(setup_state 21)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=3; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3 4 5; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"t$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  fire_stop "$tmp" "dq1" "da\n\n<!-- HINT_META {\"topic\":\"dt\",\"correct\":false,\"domain\":\"fundamentos\",\"hintLevel\":0,\"diagnostic\":\"fail\"} /HINT_META -->" > /dev/null
  fire_stop "$tmp" "dq2" "da\n\n<!-- HINT_META {\"topic\":\"dt\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0,\"diagnostic\":\"pass\"} /HINT_META -->" > /dev/null
  fire_stop "$tmp" "dq3" "da\n\n<!-- HINT_META {\"topic\":\"dt\",\"correct\":false,\"domain\":\"fundamentos\",\"hintLevel\":0,\"diagnostic\":\"fail\"} /HINT_META -->" > /dev/null
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); const c=d.pending_calibration_change; const p=d.pending_diagnostic; process.stdout.write(!c && !p ? "yes" : "no")' "$tmp/profile.json")
  [[ "$HAS" == "yes" ]] && pass "diagnostic 1/3 pass -> clears, no promotion" || fail "S21d diagnostic 1-of-3 still left state"
  teardown_state "$tmp"

  # 21e — fast downgrade preserved (3 wrong → direct pending_calibration_change)
  tmp=$(setup_state 21)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=3; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"t$i\",\"correct\":false,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); const p=d.pending_calibration_change; process.stdout.write(p && p.direction==="down" && p.from===3 && p.to===2 ? "yes" : "no")' "$tmp/profile.json")
  [[ "$HAS" == "yes" ]] && pass "level=3 + 3 wrong -> direct downgrade to 2 (no diagnostic)" || fail "S21e level 3 did not directly downgrade at 3 wrong"
  teardown_state "$tmp"

  # 21f — weighted scoring blocks: 10 correct at hintLevel 5 (full scaffolding) → no diagnostic
  tmp=$(setup_state 21)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=1; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"t$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":5} /HINT_META -->" > /dev/null
  done
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.stdout.write((d.pending_diagnostic||d.pending_calibration_change)?"yes":"no")' "$tmp/profile.json")
  [[ "$HAS" == "no" ]] && pass "10 correct at hintLevel 5 -> no diagnostic (avg weight too low)" || fail "S21f scaffolded correctness pre-maturely promoted"
  teardown_state "$tmp"

  # 21g — topic diversity blocks: 10 correct on ONE topic → no diagnostic
  tmp=$(setup_state 21)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=1; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"single-topic\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.stdout.write((d.pending_diagnostic||d.pending_calibration_change)?"yes":"no")' "$tmp/profile.json")
  [[ "$HAS" == "no" ]] && pass "10 correct on ONE topic -> no diagnostic (diversity floor)" || fail "S21g single-topic correctness pre-maturely promoted"
  teardown_state "$tmp"
fi

## S23 anti-adulation guards: depth-diversity floor + diagnostic anti-adulation
if should_run 23; then
  header "S23 anti-adulation guards (depth floor + diagnostic anti-adulation)"

  # 23a — depth diversity floor: L1, 10 correct with avg weight >= 0.5 but only
  # 4 low-hint correct (need 5). Mix: 6 at hintLevel=3 (w=0.4), 4 at hintLevel=0
  # (w=1.0). Distinct topics. avg = (6*0.4 + 4*1.0)/10 = 0.64 >= 0.5.
  # lowHintCount=4 < ceil(10/2)=5 → blocked.
  tmp=$(setup_state 23a)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=1; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  # 6 correct at hintLevel=3 (above-hint), all distinct topics
  for i in 1 2 3 4 5 6; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"topic-hi-$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":3} /HINT_META -->" > /dev/null
  done
  # 4 correct at hintLevel=0 (low-hint), distinct topics
  for i in 7 8 9 10; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"topic-lo-$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.stdout.write((d.pending_diagnostic||d.pending_calibration_change)?"yes":"no")' "$tmp/profile.json")
  [[ "$HAS" == "no" ]] && pass "depth floor blocks when low-hint correct < ceil(needed/2)" || fail "S23a depth floor did not block (4 low-hint out of 10 needed)"
  teardown_state "$tmp"

  # 23b — depth diversity floor: same as 23a but flipped — 5 low-hint, 5 high-hint.
  # avg = (5*1.0 + 5*0.4)/10 = 0.7, lowHintCount=5 >= ceil(10/2)=5 → should enter diagnostic.
  tmp=$(setup_state 23b)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=1; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  for i in 1 2 3 4 5; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"topic-lo-$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":0} /HINT_META -->" > /dev/null
  done
  for i in 6 7 8 9 10; do
    fire_stop "$tmp" "q$i" "a$i\n\n<!-- HINT_META {\"topic\":\"topic-hi-$i\",\"correct\":true,\"domain\":\"fundamentos\",\"hintLevel\":3} /HINT_META -->" > /dev/null
  done
  HAS=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); const p=d.pending_diagnostic; process.stdout.write(p && p.target_level===2 ? "yes" : "no")' "$tmp/profile.json")
  [[ "$HAS" == "yes" ]] && pass "depth floor allows when low-hint correct >= ceil(needed/2)" || fail "S23b depth floor wrongly blocked 5 low-hint of 10"
  teardown_state "$tmp"

  # 23c — diagnostic anti-adulation injection: when pending_diagnostic is set,
  # the pre-prompt hook must include ANTI-ADULATION guidance.
  tmp=$(setup_state 23c)
  node -e '
    const fs=require("fs");
    const p=process.argv[1]+"/profile.json";
    const d=JSON.parse(fs.readFileSync(p,"utf-8"));
    d.global_level=3;
    d.pending_diagnostic={target_level:4,started_turn:0,turns_asked:0,turns_passed:0,suggested_at:new Date().toISOString()};
    fs.writeFileSync(p,JSON.stringify(d,null,2));
  ' "$tmp"
  OUT=$(fire_pre "$tmp" "quiero seguir con el feature")
  echo "$OUT" | grep -q "DIAGNOSTIC MODE" && pass "diagnostic block injected while active" || fail "S23c diagnostic block missing"
  echo "$OUT" | grep -q "ANTI-ADULATION" && pass "diagnostic injects anti-adulation guidance" || fail "S23c ANTI-ADULATION guidance missing in diagnostic"
  echo "$OUT" | grep -q "default to fail\|When in doubt, set diagnostic=\"fail\"" && pass "anti-adulation tells grader to default to fail on ambiguity" || fail "S23c anti-adulation missing fail-default rule"
  teardown_state "$tmp"

  # 23d — no diagnostic, no anti-adulation (anti-adulation must not leak)
  tmp=$(setup_state 23d)
  node -e 'const fs=require("fs"); const p=process.argv[1]+"/profile.json"; const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.global_level=3; fs.writeFileSync(p,JSON.stringify(d,null,2))' "$tmp"
  OUT=$(fire_pre "$tmp" "hola")
  echo "$OUT" | grep -q "ANTI-ADULATION" && fail "S23d ANTI-ADULATION leaked when no diagnostic active" || pass "no diagnostic -> no anti-adulation leak"
  teardown_state "$tmp"
fi

## S24 immersive mode: activation, context block, timebox expiry, idempotency
if should_run 24; then
  header "S24 immersive mode (third axis: who holds the keyboard)"

  # 24a — activation writes the state with a timebox.
  tmp=$(setup_state 24a)
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 60 >/dev/null 2>&1
  OK=$(node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));
    const i=d.immersive;
    if(!i||i.active!==true||!i.expires_at){process.stdout.write("no");process.exit(0)}
    const left=(Date.parse(i.expires_at)-Date.now())/60000;
    process.stdout.write(left>55&&left<=60?"yes":"no");
  ' "$tmp/profile.json")
  [[ "$OK" == "yes" ]] && pass "immersive on --minutes 60 sets active state with timebox" || fail "S24a activation state wrong"

  # 24b — the context block replaces the per-level protocol. Level 3 would
  # normally emit "LEVEL 3 PROTOCOL"; in immersive it must not, because every
  # level protocol is a rule about how the agent writes code.
  OUT=$(fire_pre "$tmp" "agrega validacion al login")
  echo "$OUT" | grep -q "IMMERSIVE MODE" && pass "immersive block injected" || fail "S24b IMMERSIVE MODE block missing"
  echo "$OUT" | grep -q "LEVEL 3 PROTOCOL" && fail "S24b level protocol leaked into immersive mode" || pass "level protocol suppressed while immersive"
  echo "$OUT" | grep -q "^immersive: ON" && pass "header reports immersive state" || fail "S24b header line missing"

  # 24c — the rung comes from the hint ladder (level 3 starts at rung 2).
  echo "$OUT" | grep -q "CURRENT RUNG: 2 (Analogy)" && pass "rung derived from hint state (L3 -> rung 2)" || fail "S24c wrong rung"
  echo "$OUT" | grep -q "DO NOT paste code blocks" && pass "no-code-blocks rule present (the copy-paste loophole)" || fail "S24c missing no-code-block rule"
  teardown_state "$tmp"

  # 24d — an elapsed timebox must end the mode by itself, clear the state, and
  # tell the user once. A stale lock the user cannot open is the worst
  # failure mode this feature has.
  tmp=$(setup_state 24d)
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 30 >/dev/null 2>&1
  node -e '
    const fs=require("fs"),p=process.argv[1]+"/profile.json";
    const d=JSON.parse(fs.readFileSync(p,"utf-8"));
    d.immersive.expires_at=new Date(Date.now()-60000).toISOString();
    fs.writeFileSync(p,JSON.stringify(d,null,2));
  ' "$tmp"
  OUT=$(fire_pre "$tmp" "seguimos")
  echo "$OUT" | grep -q "IMMERSIVE MODE" && fail "S24d expired timebox still enforcing" || pass "expired timebox stops enforcing"
  echo "$OUT" | grep -q "timebox elapsed" && pass "user is told the session ended" || fail "S24d no elapsed notice"
  echo "$OUT" | grep -q "LEVEL 3 PROTOCOL" && pass "level protocol returns after expiry" || fail "S24d level protocol did not return"
  GONE=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.stdout.write("immersive" in d?"no":"yes")' "$tmp/profile.json")
  [[ "$GONE" == "yes" ]] && pass "expired state cleared from profile" || fail "S24d stale immersive key left in profile"
  teardown_state "$tmp"

  # 24e — off prints a summary and removes the key; idempotent on both sides.
  tmp=$(setup_state 24e)
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on >/dev/null 2>&1
  AGAIN=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on 2>&1)
  echo "$AGAIN" | grep -q "already active" && pass "immersive on is idempotent" || fail "S24e double activation not detected"
  # Since S27 the summary is the autonomy report, not a bare line count.
  OFF=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --off 2>&1)
  echo "$OFF" | grep -q "immersive session ended" && pass "off prints the autonomy report" || fail "S24e off summary missing"
  echo "$OFF" | grep -q "duration:" && pass "off reports session duration" || fail "S24e duration missing"
  OFF2=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --off 2>&1)
  echo "$OFF2" | grep -q "already off" && pass "immersive off is idempotent" || fail "S24e double off not detected"

  # 24f — with the mode off, nothing immersive may leak into the context.
  OUT=$(fire_pre "$tmp" "hola")
  echo "$OUT" | grep -q "IMMERSIVE" && fail "S24f immersive leaked while off" || pass "no immersive leak when off"
  teardown_state "$tmp"

  # 24g — guards: bad arguments and paused profile.
  tmp=$(setup_state 24g)
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes -5 >/dev/null 2>&1
  [[ "$?" == "2" ]] && pass "negative timebox rejected (exit 2)" || fail "S24g negative minutes not rejected"
  mv "$tmp/profile.json" "$tmp/profile.json.paused"
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --status >/dev/null 2>&1
  [[ "$?" == "3" ]] && pass "refuses while paused (exit 3)" || fail "S24g paused profile not detected"
  teardown_state "$tmp"
fi

## S25 immersive gate: PreToolUse lockout, bash discrimination, unlock
if should_run 25; then
  header "S25 immersive gate (PreToolUse lockout + unlock)"

  # 25a — mode off: the gate must be invisible. This is the path every
  # user of the plugin pays on every single tool call, immersive or not.
  tmp=$(setup_state 25a)
  [[ "$(gate_verdict "$tmp" Write)" == "allow" ]] && pass "gate allows Write when immersive is off" || fail "S25a gate blocked with mode off"
  [[ "$(gate_verdict "$tmp" Bash "echo hola > f.txt")" == "allow" ]] && pass "gate ignores bash writes when immersive is off" || fail "S25a gate blocked bash with mode off"

  # 25b — mode on: every code-writing tool is denied.
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 60 >/dev/null 2>&1
  for t in Write Edit MultiEdit NotebookEdit; do
    [[ "$(gate_verdict "$tmp" "$t")" == "deny" ]] && pass "denies $t while immersive" || fail "S25b $t not denied"
  done

  # 25c — the delegation loophole: a subagent writing on the agent's behalf
  # is the agent writing.
  [[ "$(gate_verdict "$tmp" Agent)" == "deny" ]] && pass "denies subagent delegation" || fail "S25c Agent not denied"
  [[ "$(gate_verdict "$tmp" Task)" == "deny" ]] && pass "denies Task delegation" || fail "S25c Task not denied"

  # 25d — bash must stay usable for real work. False positives here make the
  # mode unusable: the user needs their own tests, git and builds.
  for c in "bun test" "npm test 2>&1" "git status --short" "ls -la > /dev/null" "grep -rn foo src/"; do
    [[ "$(gate_verdict "$tmp" Bash "$c")" == "allow" ]] && pass "bash allowed: $c" || fail "S25d false positive on: $c"
  done

  # 25e — bash used as an editor is Write with extra steps.
  [[ "$(gate_verdict "$tmp" Bash 'echo "const x=1" > src/a.ts')" == "deny" ]] && pass "bash deny: shell redirect" || fail "S25e redirect not caught"
  [[ "$(gate_verdict "$tmp" Bash "sed -i 's/a/b/' src/a.ts")" == "deny" ]] && pass "bash deny: sed -i" || fail "S25e sed -i not caught"
  [[ "$(gate_verdict "$tmp" Bash "npm test | tee out.txt")" == "deny" ]] && pass "bash deny: tee" || fail "S25e tee not caught"
  [[ "$(gate_verdict "$tmp" Bash "node -e \"require('fs').writeFileSync('a.ts','x')\"")" == "deny" ]] && pass "bash deny: script write" || fail "S25e script write not caught"
  [[ "$(gate_verdict "$tmp" Bash "git apply fix.patch")" == "deny" ]] && pass "bash deny: git apply" || fail "S25e git apply not caught"
  teardown_state "$tmp"

  # 25f — unlock guards.
  tmp=$(setup_state 25f)
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --unlock --reason "x" >/dev/null 2>&1
  [[ "$?" == "2" ]] && pass "unlock refused when immersive is not active" || fail "S25f unlock allowed while off"
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 60 >/dev/null 2>&1
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --unlock >/dev/null 2>&1
  [[ "$?" == "2" ]] && pass "unlock requires a reason" || fail "S25f reasonless unlock accepted"

  # 25g — a live unlock stands the gate down completely, and is logged.
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --unlock --reason "prod hotfix" --minutes 5 >/dev/null 2>&1
  [[ "$(gate_verdict "$tmp" Write)" == "allow" ]] && pass "unlock lets the agent write again" || fail "S25g gate still blocking during unlock"
  LOGGED=$(node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));
    const u=d.immersive.unlocks;
    process.stdout.write(u.length===1 && u[0].reason==="prod hotfix" && u[0].minutes===5 ? "yes":"no");
  ' "$tmp/profile.json")
  [[ "$LOGGED" == "yes" ]] && pass "unlock is logged with reason and duration" || fail "S25g unlock not logged properly"

  # 25h — when the unlock elapses the gate closes again by itself.
  node -e '
    const fs=require("fs"),p=process.argv[1]+"/profile.json";
    const d=JSON.parse(fs.readFileSync(p,"utf-8"));
    d.immersive.unlocks[0].at=new Date(Date.now()-10*60000).toISOString();
    fs.writeFileSync(p,JSON.stringify(d,null,2));
  ' "$tmp"
  [[ "$(gate_verdict "$tmp" Write)" == "deny" ]] && pass "gate re-locks when the unlock elapses" || fail "S25h expired unlock still open"
  teardown_state "$tmp"

  # 25j — the gate must never lock the user out of its own controls.
  # `socratic off`, `level N` and `challenge` all mutate profile.json via
  # the Write tool; gating that path would put the key inside the locked
  # room. The exemption is a prefix match, so it is also where a sibling
  # directory or a `..` segment could smuggle a write through.
  tmp=$(setup_state 25j)
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 60 >/dev/null 2>&1
  gate_path() {
    local out
    out=$(node -e '
      process.stdout.write(JSON.stringify({
        tool_name: process.argv[1],
        tool_input: { file_path: process.argv[2], content: "x" },
        hook_event_name: "PreToolUse",
      }));
    ' "$1" "$2" | SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/hook-pre-tool.sh")
    if [[ -z "$out" ]]; then echo "allow"; else echo "deny"; fi
  }
  [[ "$(gate_path Write "$tmp/profile.json")" == "allow" ]] && pass "control plane stays writable (profile.json)" || fail "S25j locked out of profile.json"
  [[ "$(gate_path Write "$tmp/sessions/x.json")" == "allow" ]] && pass "control plane stays writable (session file)" || fail "S25j locked out of session file"
  [[ "$(gate_path Write "$tmp-otro/profile.json")" == "deny" ]] && pass "exemption does not leak to a similarly named sibling dir" || fail "S25j sibling dir exempted"
  [[ "$(gate_path Write "$tmp/../escape.ts")" == "deny" ]] && pass "exemption survives a .. traversal" || fail "S25j traversal escaped the gate"
  [[ "$(gate_path Write "$tmp/../../elsewhere/app.ts")" == "deny" ]] && pass "exemption survives a deeper traversal" || fail "S25j deep traversal escaped"
  teardown_state "$tmp"

  # 25i — the kill switches must win over the gate. Someone who turned the
  # plugin off, or paused it, must never be blocked by a stale immersive key.
  tmp=$(setup_state 25i)
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 60 >/dev/null 2>&1
  node -e '
    const fs=require("fs"),p=process.argv[1]+"/profile.json";
    const d=JSON.parse(fs.readFileSync(p,"utf-8")); d.enabled=false;
    fs.writeFileSync(p,JSON.stringify(d,null,2));
  ' "$tmp"
  [[ "$(gate_verdict "$tmp" Write)" == "allow" ]] && pass "enabled=false disarms the gate" || fail "S25i gate ignored the kill switch"

  # An elapsed timebox must not keep the gate shut either.
  node -e '
    const fs=require("fs"),p=process.argv[1]+"/profile.json";
    const d=JSON.parse(fs.readFileSync(p,"utf-8"));
    d.enabled=true; d.immersive.expires_at=new Date(Date.now()-60000).toISOString();
    fs.writeFileSync(p,JSON.stringify(d,null,2));
  ' "$tmp"
  [[ "$(gate_verdict "$tmp" Write)" == "allow" ]] && pass "expired timebox disarms the gate" || fail "S25i expired timebox still blocking"
  teardown_state "$tmp"
fi

## S26 immersive rules wiring + user_wrote telemetry
if should_run 26; then
  header "S26 immersive rules + user_wrote telemetry"

  # 26a — while immersive, the context must point at the immersive rule
  # files and explicitly retire the level/mode ones, which are all
  # instructions about how to write code.
  tmp=$(setup_state 26a)
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 60 >/dev/null 2>&1
  OUT=$(fire_pre "$tmp" "quiero agregar validacion al login")
  echo "$OUT" | grep -q "immersive.md + immersive-ladder.md" && pass "rules line points at the immersive rule files" || fail "S26a immersive rules not referenced"
  echo "$OUT" | grep -q "do NOT apply while immersive" && pass "level/mode rules explicitly retired" || fail "S26a level/mode not retired"
  echo "$OUT" | grep -q "user_wrote" && pass "META PROTOCOL requests user_wrote" || fail "S26a user_wrote not requested"

  # 26b — and none of that may leak when the mode is off.
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --off >/dev/null 2>&1
  OUT=$(fire_pre "$tmp" "quiero agregar validacion al login")
  echo "$OUT" | grep -q "immersive-ladder" && fail "S26b immersive rules leaked while off" || pass "no immersive rules when off"
  echo "$OUT" | grep -q "user_wrote" && fail "S26b user_wrote leaked while off" || pass "no user_wrote request when off"
  echo "$OUT" | grep -q "level-3-\*.md" && pass "normal rules line restored" || fail "S26b normal rules line missing"
  teardown_state "$tmp"

  # 26c — the Stop hook must persist user_wrote into the turn record.
  tmp=$(setup_state 26c)
  fire_stop "$tmp" "ya lo escribi" 'listo\n\n<!-- HINT_META {"topic":"validation","correct":true,"domain":"backend","hintLevel":2,"user_wrote":true} /HINT_META -->' >/dev/null
  GOT=$(node -e '
    const fs=require("fs");
    const d=JSON.parse(fs.readFileSync(process.argv[1],"utf-8"));
    process.stdout.write(String(d.turns[0].user_wrote));
  ' "$tmp/sessions/$(date -u +%Y-%m-%d).json")
  [[ "$GOT" == "true" ]] && pass "user_wrote=true persisted to the turn record" || fail "S26c user_wrote not persisted (got $GOT)"

  # A turn without the field must record null, not false — "no data" and
  # "the user wrote nothing" are different facts for the autonomy report.
  fire_stop "$tmp" "otra cosa" 'ok\n\n<!-- HINT_META {"topic":"x","correct":null,"domain":null,"hintLevel":1} /HINT_META -->' >/dev/null
  GOT=$(node -e '
    const fs=require("fs");
    const d=JSON.parse(fs.readFileSync(process.argv[1],"utf-8"));
    process.stdout.write(String(d.turns[1].user_wrote));
  ' "$tmp/sessions/$(date -u +%Y-%m-%d).json")
  [[ "$GOT" == "null" ]] && pass "absent user_wrote records as null, not false" || fail "S26c absent field became $GOT"
  teardown_state "$tmp"

  # 26d — the rule files themselves must exist and carry the load-bearing
  # rules, since the context block only references them by path.
  LADDER="$PLUGIN_DIR/skills/socratic/rules/immersive-ladder.md"
  RULES="$PLUGIN_DIR/skills/socratic/rules/immersive.md"
  [[ -f "$LADDER" && -f "$RULES" ]] && pass "immersive rule files exist" || fail "S26d rule files missing"
  grep -q "copy your response into their editor" "$LADDER" && pass "ladder states the copy-paste litmus test" || fail "S26d litmus test missing"
  grep -q "IS NOT" "$LADDER" && pass "ladder defines what a work order is NOT" || fail "S26d work order negative definition missing"
  grep -q -i "do not moralize\|Do NOT moralize" "$RULES" && pass "rules forbid moralizing about the unlock" || fail "S26d unlock moralizing rule missing"
fi

## S27 autonomy report: git measurement, summary, journal section
if should_run 27; then
  header "S27 autonomy report (immersive metric)"

  # A throwaway git repo, with the socratic state kept OUTSIDE it — state
  # files inside the tree would be counted as the user's work.
  repo="${TEST_ROOT}/repo-27"
  mkdir -p "$repo"
  ( cd "$repo" && git init -q . && git config user.email t@t && git config user.name t &&
    printf 'line1\nline2\n' > a.txt && git add . && git commit -qm base ) >/dev/null 2>&1

  tmp=$(setup_state 27)
  ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 60 ) >/dev/null 2>&1
  HASBASE=$(node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));
    const b=d.immersive.git_baseline;
    process.stdout.write(b && b.head ? "yes":"no");
  ' "$tmp/profile.json")
  [[ "$HASBASE" == "yes" ]] && pass "git baseline captured at activation" || fail "S27 no git baseline"

  # 5 lines committed mid-session + 3 uncommitted + 1 deleted. Committing
  # moves HEAD and resets the working-tree diff, so a naive measurement
  # would go negative exactly when the user was most productive.
  ( cd "$repo" && printf 'a\nb\nc\nd\ne\n' >> a.txt && git add . && git commit -qm work ) >/dev/null 2>&1
  ( cd "$repo" && printf 'f\ng\nh\n' >> a.txt )
  node -e '
    const fs=require("fs"),p=process.argv[1]+"/a.txt";
    const l=fs.readFileSync(p,"utf8").split("\n"); l.splice(0,1);
    fs.writeFileSync(p,l.join("\n"));
  ' "$repo"

  OUT=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --off 2>&1 )
  echo "$OUT" | grep -q "you wrote: +8 / -1 lines" && pass "line count survives a mid-session commit (+8/-1)" || fail "S27 wrong line count: $(echo "$OUT" | grep 'you wrote')"
  echo "$OUT" | grep -q "average ladder rung" && pass "report includes the ladder rung" || fail "S27 rung missing"
  echo "$OUT" | grep -q "unlocks: 0" && pass "report includes unlock count" || fail "S27 unlocks missing"

  # The summary must be archived where the journal can find it.
  ARCH=$(node -e '
    const fs=require("fs");
    const d=JSON.parse(fs.readFileSync(process.argv[1],"utf-8"));
    const a=d.immersive_summaries;
    process.stdout.write(Array.isArray(a)&&a.length===1&&a[0].lines_added===8?"yes":"no");
  ' "$tmp/sessions/$(date -u +%Y-%m-%d).json")
  [[ "$ARCH" == "yes" ]] && pass "summary archived to the session file" || fail "S27 summary not archived"

  # The journal must surface it.
  JOUT=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/build-journal.ts" --period today 2>&1)
  echo "$JOUT" | grep -q "## Autonomy (immersive mode)" && pass "journal has the autonomy section" || fail "S27 journal section missing"
  echo "$JOUT" | grep -q "you wrote: +8 / -0 lines\|you wrote: +8 / -1 lines" && pass "journal reports the measured lines" || fail "S27 journal lines wrong"
  teardown_state "$tmp"

  # 27b — an unlock contaminates the line count (the agent can write while
  # it lasts), so the report must say so rather than imply a clean number.
  tmp=$(setup_state 27b)
  ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 60 ) >/dev/null 2>&1
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --unlock --reason "prod hotfix" --minutes 5 >/dev/null 2>&1
  OUT=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --off 2>&1 )
  echo "$OUT" | grep -q "during an unlock is included" && pass "report discloses unlock contamination" || fail "S27b contamination note missing"
  echo "$OUT" | grep -q "prod hotfix" && pass "report lists the unlock reason" || fail "S27b unlock reason missing"
  teardown_state "$tmp"

  # 27c — outside a git repo the report degrades instead of failing.
  tmp=$(setup_state 27c)
  nonrepo="${TEST_ROOT}/nonrepo-27"; mkdir -p "$nonrepo"
  ( cd "$nonrepo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 60 ) >/dev/null 2>&1
  OUT=$( cd "$nonrepo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --off 2>&1 )
  echo "$OUT" | grep -q "not measured" && pass "degrades gracefully outside a git repo" || fail "S27c did not degrade cleanly"
  teardown_state "$tmp"

  # 27d — ending by timebox must report too. Running out the clock is the
  # common case; it must not be the silent one.
  tmp=$(setup_state 27d)
  ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 30 ) >/dev/null 2>&1
  node -e '
    const fs=require("fs"),p=process.argv[1]+"/profile.json";
    const d=JSON.parse(fs.readFileSync(p,"utf-8"));
    d.immersive.expires_at=new Date(Date.now()-60000).toISOString();
    fs.writeFileSync(p,JSON.stringify(d,null,2));
  ' "$tmp"
  OUT=$(fire_pre "$tmp" "seguimos")
  echo "$OUT" | grep -q "session summary (relay verbatim)" && pass "expiry injects the summary for the model to relay" || fail "S27d expiry summary missing"
  echo "$OUT" | grep -q "timebox elapsed" && pass "expiry summary says how it ended" || fail "S27d ended_by missing"
  ARCH=$(node -e '
    const fs=require("fs");
    const d=JSON.parse(fs.readFileSync(process.argv[1],"utf-8"));
    process.stdout.write(Array.isArray(d.immersive_summaries)&&d.immersive_summaries.length===1?"yes":"no");
  ' "$tmp/sessions/$(date -u +%Y-%m-%d).json")
  [[ "$ARCH" == "yes" ]] && pass "expired session is archived too" || fail "S27d expired summary not archived"
  teardown_state "$tmp"
fi

## S28 drills: selection, rotation, guards, build measurement
if should_run 28; then
  header "S28 drills (analyze + build)"

  # A repo with several drillable files plus decoys that must never be
  # selected: too short, generated, vendored, and a lock file.
  repo="${TEST_ROOT}/repo-28"
  mkdir -p "$repo/src" "$repo/node_modules/pkg" "$repo/dist"
  # Trailing newline matters: appending to a file that lacks one merges
  # into its last line, and git then reports that line as modified — the
  # measurement would look wrong when it is the fixture that is unusual.
  for n in alpha beta gamma delta; do
    node -e '
      const fs=require("fs");
      fs.writeFileSync(process.argv[1], Array.from({length:60},(_,i)=>"const l"+i+" = "+i).join("\n") + "\n");
    ' "$repo/src/$n.ts"
  done
  echo "const tiny = 1" > "$repo/src/tiny.ts"
  node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],Array.from({length:60},(_,i)=>"x"+i).join("\n"))' "$repo/node_modules/pkg/index.js"
  node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],Array.from({length:60},(_,i)=>"y"+i).join("\n"))' "$repo/dist/app.min.js"
  node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],Array.from({length:60},(_,i)=>"z"+i).join("\n"))' "$repo/package-lock.json"
  ( cd "$repo" && git init -q . && git config user.email t@t && git config user.name t &&
    git add -A && git commit -qm base ) >/dev/null 2>&1

  # 28a — selection must land on real source, never on the decoys.
  tmp=$(setup_state 28a)
  OUT=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --kind analyze 2>&1 )
  PICK=$(echo "$OUT" | grep "^file:" | sed 's/^file: //')
  case "$PICK" in
    src/alpha.ts|src/beta.ts|src/gamma.ts|src/delta.ts) pass "analyze selects a real source file ($PICK)" ;;
    *) fail "S28a selected a bad file: $PICK" ;;
  esac
  echo "$OUT" | grep -q "^lines: 60" && pass "reports the file size" || fail "S28a line count missing"

  # 28b — a second drill must not start on top of a running one.
  ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --kind analyze ) >/dev/null 2>&1
  [[ "$?" == "2" ]] && pass "refuses a second concurrent drill" || fail "S28b concurrent drill allowed"
  ST=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --status 2>&1 )
  echo "$ST" | grep -q "drill: analyze" && pass "status reports the running drill" || fail "S28b status wrong"
  ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --done ) >/dev/null 2>&1
  ST=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --status 2>&1 )
  echo "$ST" | grep -q "none active" && pass "done clears the drill" || fail "S28b done did not clear"

  # 28c — rotation: with 4 drillable files, 4 drills must not repeat.
  # Fresh state on purpose: the guarantee only holds while the rotation
  # window has not consumed the whole candidate pool, and the earlier
  # subtests already spent some of it. Reusing that history would make
  # this assertion pass or fail on the dice.
  teardown_state "$tmp"
  tmp=$(setup_state 28c)
  SEEN=""
  for i in 1 2 3 4; do
    P=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --kind analyze 2>/dev/null | grep "^file:" | sed 's/^file: //')
    SEEN="$SEEN$P\n"
    ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --done ) >/dev/null 2>&1
  done
  UNIQ=$(printf "$SEEN" | sort -u | grep -c .)
  [[ "$UNIQ" == "4" ]] && pass "rotation avoids repeating recent files" || fail "S28c rotation repeated (unique=$UNIQ)"

  # 28d — an explicit path is honored; a bad one is refused.
  OUT=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --kind analyze --file src/tiny.ts 2>&1 )
  echo "$OUT" | grep -q "file: src/tiny.ts" && pass "explicit file overrides selection" || fail "S28d explicit file ignored"
  ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --cancel ) >/dev/null 2>&1
  ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --kind analyze --file nope.ts ) >/dev/null 2>&1
  [[ "$?" == "2" ]] && pass "missing file refused (exit 2)" || fail "S28d missing file accepted"
  teardown_state "$tmp"

  # 28e — a build drill without immersive is not a drill.
  tmp=$(setup_state 28e)
  ERR=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --kind build 2>&1 )
  echo "$ERR" | grep -q "needs immersive mode" && pass "build drill requires immersive mode" || fail "S28e build allowed without immersive"

  # 28f — with immersive on, the build drill measures what the user wrote.
  ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 45 ) >/dev/null 2>&1
  OUT=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --kind build 2>&1 )
  echo "$OUT" | grep -q "measuring: yes (git)" && pass "build drill captures a git baseline" || fail "S28f no baseline"
  ( cd "$repo" && printf 'a\nb\nc\nd\ne\nf\n' >> src/alpha.ts )
  OUT=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --done 2>&1 )
  echo "$OUT" | grep -q "you wrote: +6 / -0 lines" && pass "build drill reports lines written" || fail "S28f wrong count: $(echo "$OUT" | grep 'you wrote')"
  teardown_state "$tmp"

  # 28g — the hook must announce a running drill every turn, with its
  # protocol, and say nothing when none is running.
  tmp=$(setup_state 28g)
  ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --kind analyze --file src/beta.ts ) >/dev/null 2>&1
  OUT=$(fire_pre "$tmp" "seguimos")
  echo "$OUT" | grep -q "^drill: analyze on src/beta.ts" && pass "hook announces the active drill" || fail "S28g drill not announced"
  echo "$OUT" | grep -q "ANALYZE DRILL active" && pass "hook injects the analyze protocol" || fail "S28g analyze protocol missing"
  echo "$OUT" | grep -q "Ask ONE question per turn" && pass "protocol carries the one-question rule" || fail "S28g one-question rule missing"
  ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --done ) >/dev/null 2>&1
  OUT=$(fire_pre "$tmp" "seguimos")
  echo "$OUT" | grep -q "DRILL active" && fail "S28g drill leaked after done" || pass "no drill note once finished"
  teardown_state "$tmp"

  # 28h — the rules file must carry the load-bearing pedagogy.
  DR="$PLUGIN_DIR/skills/socratic/rules/drills.md"
  [[ -f "$DR" ]] && pass "drills rule file exists" || fail "S28h drills.md missing"
  grep -q "ONE question per turn" "$DR" && pass "rules state the one-question protocol" || fail "S28h one-question rule missing"
  grep -q "acceptance criteria BEFORE any code" "$DR" && pass "rules require criteria before code" || fail "S28h criteria rule missing"
  grep -q "failed drill is a successful measurement" "$DR" && pass "rules frame failure as the finding" || fail "S28h failure framing missing"
fi

## S29 scaffold window: create-vs-edit, caps, accounting, report subtraction
if should_run 29; then
  header "S29 scaffold window"

  repo="${TEST_ROOT}/repo-29"
  mkdir -p "$repo"
  ( cd "$repo" && git init -q . && git config user.email t@t && git config user.name t &&
    printf 'base\n' > README.md && git add . && git commit -qm base ) >/dev/null 2>&1

  # Helper: ask the gate about a Write, with explicit content.
  gate_write() {
    local tmp="$1"; local path="$2"; local content="$3"; local tool="${4:-Write}"
    local out
    out=$(node -e '
      process.stdout.write(JSON.stringify({
        tool_name: process.argv[1],
        tool_input: { file_path: process.argv[2], content: process.argv[3] },
        hook_event_name: "PreToolUse",
      }));
    ' "$tool" "$path" "$content" | SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/hook-pre-tool.sh")
    if [[ -z "$out" ]]; then echo "allow"; else echo "deny"; fi
  }

  # 29a — the window is not available outside immersive mode, where the
  # agent already writes freely and it would mean nothing.
  tmp=$(setup_state 29a)
  ERR=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --scaffold 2>&1 )
  echo "$ERR" | grep -q "needs immersive mode" && pass "scaffold requires immersive mode" || fail "S29a scaffold granted outside immersive"

  # 29b — per-level allowance comes from algorithm.json (level 3 -> 5).
  ( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 60 ) >/dev/null 2>&1
  OUT=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --scaffold 2>&1 )
  echo "$OUT" | grep -q "5 new file(s)" && pass "file allowance scales with level (L3 -> 5)" || fail "S29b wrong allowance: $OUT"

  # 29c — the create/edit line. This is the whole enforcement idea: the
  # gate decides on whether the file exists, never on whether the code
  # "looks like boilerplate".
  [[ "$(gate_write "$tmp" "$repo/nuevo.html" "<html>")" == "allow" ]] && pass "creating a new file is allowed" || fail "S29c new file blocked"
  [[ "$(gate_write "$tmp" "$repo/README.md" "x")" == "deny" ]] && pass "writing over an existing file is denied" || fail "S29c existing file allowed"
  [[ "$(gate_write "$tmp" "$repo/nuevo.html" "x" Edit)" == "deny" ]] && pass "Edit stays denied with the window open" || fail "S29c Edit allowed"
  [[ "$(gate_write "$tmp" "$repo/otro.ts" "y" MultiEdit)" == "deny" ]] && pass "MultiEdit stays denied with the window open" || fail "S29c MultiEdit allowed"

  # 29d — a scaffold is a skeleton, not an implementation.
  BIG=$(node -e 'process.stdout.write(Array.from({length:200},(_,i)=>"l"+i).join("\n"))')
  [[ "$(gate_write "$tmp" "$repo/gigante.ts" "$BIG")" == "deny" ]] && pass "file over the line cap is denied" || fail "S29d line cap not enforced"

  # A denial must not consume a slot: 1 file used so far (29c), not 2.
  USED=$(node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));
    process.stdout.write(String(d.immersive.scaffold.files_used));
  ' "$tmp/profile.json")
  [[ "$USED" == "1" ]] && pass "denied writes do not consume a slot" || fail "S29d slot count wrong (got $USED)"

  # 29e — exhausting the allowance closes the window by itself.
  for i in 2 3 4 5; do gate_write "$tmp" "$repo/f$i.ts" "a
b" >/dev/null; done
  [[ "$(gate_write "$tmp" "$repo/f6.ts" "a")" == "deny" ]] && pass "window closes when the allowance runs out" || fail "S29e window still open past the cap"
  ST=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --scaffold-status 2>&1 )
  echo "$ST" | grep -q "no window open" && pass "status reports the exhausted window as closed" || fail "S29e status still open"
  teardown_state "$tmp"

  # 29f — accounting: agent lines are tracked and subtracted, and the
  # user's own new files are counted even before `git add`.
  repo2="${TEST_ROOT}/repo-29f"
  mkdir -p "$repo2"
  ( cd "$repo2" && git init -q . && git config user.email t@t && git config user.name t &&
    printf 'base\n' > README.md && git add . && git commit -qm base ) >/dev/null 2>&1
  tmp=$(setup_state 29f)
  ( cd "$repo2" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --on --minutes 60 ) >/dev/null 2>&1
  ( cd "$repo2" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --scaffold ) >/dev/null 2>&1

  # The agent scaffolds 12 lines (gate says allow, then the tool writes).
  AGENT=$(node -e 'process.stdout.write(Array.from({length:12},(_,i)=>"a"+i).join("\n")+"\n")')
  [[ "$(gate_write "$tmp" "$repo2/skeleton.html" "$AGENT")" == "allow" ]] || fail "S29f scaffold write blocked"
  node -e 'require("fs").writeFileSync(process.argv[1], process.argv[2])' "$repo2/skeleton.html" "$AGENT"

  # The user writes 15 lines in a brand-new, still-untracked file.
  node -e '
    const fs=require("fs");
    fs.writeFileSync(process.argv[1], Array.from({length:15},(_,i)=>"u"+i).join("\n")+"\n");
  ' "$repo2/mine.js"

  OUT=$( cd "$repo2" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/immersive.ts" --off 2>&1 )
  echo "$OUT" | grep -q "you wrote: +15 / -0 lines" && pass "untracked new files count as the user's work" || fail "S29f wrong user count: $(echo "$OUT" | grep 'you wrote')"
  echo "$OUT" | grep -q "scaffolded by the agent: +12 lines" && pass "agent lines are reported separately" || fail "S29f scaffold lines missing"
  echo "$OUT" | grep -q "excluded from the count above" && pass "report states the subtraction" || fail "S29f subtraction not disclosed"

  ARCH=$(node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));
    const s=d.immersive_summaries[0];
    process.stdout.write(s.scaffold_lines===12 && s.scaffold_windows===1 && s.unlock_count===0 ? "yes":"no");
  ' "$tmp/sessions/$(date -u +%Y-%m-%d).json")
  [[ "$ARCH" == "yes" ]] && pass "scaffold is accounted apart from unlocks" || fail "S29f scaffold/unlock accounting mixed"
  teardown_state "$tmp"

  # 29g — the rules must forbid inferring the window from prose.
  RULES="$PLUGIN_DIR/skills/socratic/rules/immersive.md"
  grep -q "Never treat prose as a grant" "$RULES" && pass "rules forbid inferring a grant from prose" || fail "S29g prose rule missing"
  grep -q -i "suggest" "$RULES" && pass "rules allow suggesting the command" || fail "S29g suggestion rule missing"
fi

# ==========================================================================
summary
[[ "$FAIL_COUNT" -eq 0 ]]
