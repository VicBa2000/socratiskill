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
#   bash tests/run-all.sh --only <N>      # run only scenario N (1..34; 24 retired into 19/25/32)
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

# Set the axis level on an existing state dir. The level is the single
# pedagogical setting, so most scenarios move it rather than flipping a
# separate mode switch.
set_level() {
  node -e '
    const fs=require("fs"); const p=process.argv[1];
    const d=JSON.parse(fs.readFileSync(p,"utf-8"));
    d.global_level = Number(process.argv[2]);
    d.enabled = true;
    d.schema_version = 2;
    delete d.mode;
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  ' "$1/profile.json" "$2"
}

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

## S19 per-level protocol blocks (one axis, no mode)
if should_run 19; then
  header "S19 per-level protocol blocks"

  # The block is chosen by LEVEL and nothing else. There is no mode to
  # cross it with any more: "who writes the code" IS the level, so the
  # ten level x mode combinations collapsed into six.

  # 19a — L1 keeps the hard limits. It is the only level on the axis
  # where the agent authors, so it is the only one that needs a leash on
  # HOW it authors.
  tmp=$(setup_state 19a); set_level "$tmp" 1
  OUT=$(fire_pre "$tmp" "implementame algo")
  echo "$OUT" | grep -q "LEVEL 1 HARD LIMITS" && pass "L1: HARD LIMITS block injected" || fail "S19a missing HARD LIMITS at level 1"
  echo "$OUT" | grep -q "DO NOT call Write" && pass "L1: block reminds about the approval gate" || fail "S19a2 missing Write gate reminder"
  echo "$OUT" | grep -q "every line has to teach" && pass "L1 is distinguished from level 6" || fail "S19a3 L1 not distinguished from autopilot"
  teardown_state "$tmp"

  # 19b-d — L2/L3/L4 share the authorship core and differ in what they
  # may put in a file and what unit they hand over.
  for lvl in 2 3 4; do
    tmp=$(setup_state "19-l$lvl"); set_level "$tmp" "$lvl"
    OUT=$(fire_pre "$tmp" "dame una funcion que valide emails")
    echo "$OUT" | grep -q "LEVEL $lvl PROTOCOL" && pass "L$lvl: protocol block injected" || fail "S19b L$lvl protocol block missing"
    echo "$OUT" | grep -q "DO NOT edit files that already exist" && pass "L$lvl: edit prohibition stated" || fail "S19b L$lvl missing edit prohibition"
    echo "$OUT" | grep -q "DO NOT paste code blocks" && pass "L$lvl: paste prohibition stated" || fail "S19b L$lvl missing paste prohibition"
    echo "$OUT" | grep -q "LEVEL 1 HARD LIMITS" && fail "S19b L1 block leaked into L$lvl" || pass "L$lvl: no L1 leak"
    teardown_state "$tmp"
  done

  # 19e — the levels differ where the contract says they differ.
  tmp=$(setup_state 19e); set_level "$tmp" 2
  fire_pre "$tmp" "x" | grep -q "at most 8 executable statements" && pass "L2 may write trivial bodies" || fail "S19e L2 allowance wrong"
  set_level "$tmp" 3
  fire_pre "$tmp" "x" | grep -q "ZERO executable statements" && pass "L3 may write no bodies at all" || fail "S19e L3 allowance wrong"
  teardown_state "$tmp"

  # 19f — L5 gets the authorship core but no direction: decomposing is a
  # lower-level move, and offering it here is the most common leak.
  tmp=$(setup_state 19f); set_level "$tmp" 5
  OUT=$(fire_pre "$tmp" "implementame algo")
  echo "$OUT" | grep -q "LEVEL 5 PROTOCOL" && pass "L5: protocol block injected" || fail "S19f L5 block missing"
  echo "$OUT" | grep -q "You do NOT direct the work" && pass "L5: forbidden from decomposing" || fail "S19f L5 direction not forbidden"
  teardown_state "$tmp"

  # 19g — L6 is the axis switched off. Any pedagogical instruction here
  # would contradict what the user asked for by typing `level 6`.
  tmp=$(setup_state 19g); set_level "$tmp" 6
  OUT=$(fire_pre "$tmp" "implementame algo")
  echo "$OUT" | grep -q "LEVEL 6 (axis off)" && pass "L6: axis-off block injected" || fail "S19g L6 block missing"
  echo "$OUT" | grep -q "DO NOT edit files that already exist" && fail "S19g authorship prohibition leaked into L6" || pass "L6: no authorship prohibition"
  echo "$OUT" | grep -q "Do NOT comment on the fact that the user is at level 6" && pass "L6: no commentary about being there" || fail "S19g L6 missing the no-commentary rule"
  echo "$OUT" | grep -q "HINT_META" && pass "L6 still reports telemetry" || fail "S19g L6 lost telemetry"
  teardown_state "$tmp"

  # 19h — an open escape overrides the level block entirely, and forbids
  # commentary about it. Flattery and scolding are the same error.
  tmp=$(setup_state 19h); set_level "$tmp" 3
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/escape.ts" --reason "prod" --minutes 10 >/dev/null 2>&1
  OUT=$(fire_pre "$tmp" "escribime esto")
  echo "$OUT" | grep -q "ESCAPE OPEN" && pass "escape block injected" || fail "S19h escape block missing"
  echo "$OUT" | grep -q "LEVEL 3 PROTOCOL" && fail "S19h level protocol leaked during escape" || pass "escape replaces the level protocol"
  echo "$OUT" | grep -q -i "do NOT moralize" && pass "escape forbids moralizing" || fail "S19h moralizing not forbidden"
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

## S25 the gate reads the axis: authorship lockout by level
if should_run 25; then
  header "S25 gate by level (PreToolUse lockout + escape)"

  # 25a — L1: the agent is SUPPOSED to write. The gate must be invisible,
  # and this is the path every user pays on every tool call.
  tmp=$(setup_state 25a)
  set_level "$tmp" 1
  [[ "$(gate_verdict "$tmp" Write)" == "allow" ]] && pass "gate allows Write at L1" || fail "S25a gate blocked Write at L1"
  [[ "$(gate_verdict "$tmp" Bash "echo hola > f.txt")" == "allow" ]] && pass "gate ignores bash writes at L1" || fail "S25a gate blocked bash at L1"

  # 25b — L3: every tool that changes existing code is denied.
  set_level "$tmp" 3
  for t in Edit MultiEdit NotebookEdit; do
    [[ "$(gate_verdict "$tmp" "$t")" == "deny" ]] && pass "denies $t at L3" || fail "S25b $t not denied"
  done
  # Write of a file that does not exist is judged by SHAPE, not blocked
  # outright: "x" is one executable statement and L3 allows zero.
  [[ "$(gate_verdict "$tmp" Write)" == "deny" ]] && pass "denies a Write carrying statements at L3" || fail "S25b statement Write not denied"

  # 25c — the delegation loophole: a subagent writing on the agent's behalf
  # is the agent writing.
  [[ "$(gate_verdict "$tmp" Agent)" == "deny" ]] && pass "denies subagent delegation" || fail "S25c Agent not denied"
  [[ "$(gate_verdict "$tmp" Task)" == "deny" ]] && pass "denies Task delegation" || fail "S25c Task not denied"

  # 25d — bash must stay usable for real work. False positives here make
  # the axis unusable: the user needs their own tests, git and builds, and
  # running them is exactly the activity the axis exists to produce.
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

  # 25f — escape guards. The reason IS the accountability mechanism; an
  # escape with no record is how the autonomy number stops meaning
  # anything.
  tmp=$(setup_state 25f)
  set_level "$tmp" 3
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/escape.ts" >/dev/null 2>&1 \
    && fail "S25f escape accepted without a reason" || pass "escape requires a reason"
  set_level "$tmp" 1
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/escape.ts" "x" >/dev/null 2>&1 \
    && fail "S25f escape accepted at L1" || pass "escape refused at L1 (nothing to escape)"
  set_level "$tmp" 6
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/escape.ts" "x" >/dev/null 2>&1 \
    && fail "S25f escape accepted at L6" || pass "escape refused at L6 (axis already off)"
  teardown_state "$tmp"

  # 25g — an open escape stands the gate down completely, and is logged.
  tmp=$(setup_state 25g)
  set_level "$tmp" 3
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/escape.ts" --reason "prod incident" --minutes 10 >/dev/null 2>&1
  [[ "$(gate_verdict "$tmp" Write)" == "allow" ]] && pass "escape allows Write" || fail "S25g gate still blocking during escape"
  [[ "$(gate_verdict "$tmp" Edit)" == "allow" ]] && pass "escape allows Edit" || fail "S25g Edit still blocked during escape"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit((Array.isArray(d.escapes) && d.escapes[0].reason==="prod incident")?0:1)' "$tmp/profile.json" \
    && pass "escape logged with its reason" || fail "S25g escape not logged"

  # 25h — an expired escape re-arms the gate on its own. A valve that
  # stays open because nobody closed it is the same as no valve.
  node -e '
    const fs=require("fs"); const p=process.argv[1];
    const d=JSON.parse(fs.readFileSync(p,"utf-8"));
    d.escapes[0].at = new Date(Date.now() - 30*60000).toISOString();
    fs.writeFileSync(p, JSON.stringify(d));' "$tmp/profile.json"
  [[ "$(gate_verdict "$tmp" Edit)" == "deny" ]] && pass "expired escape re-arms the gate" || fail "S25h expired escape still open"
  teardown_state "$tmp"

  # 25i — kill switches. Both must fully disarm: a gate that keeps firing
  # after the user turned the plugin off gets the plugin uninstalled.
  tmp=$(setup_state 25i)
  set_level "$tmp" 3
  node -e 'const fs=require("fs"),p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf-8"));d.enabled=false;fs.writeFileSync(p,JSON.stringify(d));' "$tmp/profile.json"
  [[ "$(gate_verdict "$tmp" Edit)" == "allow" ]] && pass "enabled=false disarms the gate" || fail "S25i disabled plugin still gating"
  rm -f "$tmp/profile.json"
  [[ "$(gate_verdict "$tmp" Edit)" == "allow" ]] && pass "no profile disarms the gate" || fail "S25i missing profile still gating"
  teardown_state "$tmp"

  # 25j — the locked-room bug. `socratic off`, `level N` and `challenge`
  # all mutate profile.json through Write, so gating that path would let
  # the axis block the very commands that change it. The exemption must
  # be exact: resolve() first (so a ".." path cannot walk out) and compare
  # on a separator boundary (so a sibling directory whose name merely
  # starts the same way is not exempted too).
  tmp=$(setup_state 25j)
  set_level "$tmp" 3
  gate_path_verdict() {
    local out
    out=$(node -e '
      process.stdout.write(JSON.stringify({tool_name:"Write",tool_input:{file_path:process.argv[1],content:process.argv[2]||"const x = 1"},hook_event_name:"PreToolUse"}));
    ' "$1" "${2:-}" | SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/hook-pre-tool.sh")
    if [[ -z "$out" ]]; then echo "allow"; else echo "deny"; fi
  }
  [[ "$(gate_path_verdict "$tmp/profile.json")" == "allow" ]] && pass "the plugin's own state is exempt" || fail "S25j locked the user out of the control panel"
  [[ "$(gate_path_verdict "$tmp/sessions/x.json")" == "allow" ]] && pass "state subdirectories are exempt" || fail "S25j session dir not exempt"
  # A statement-carrying .ts in a look-alike sibling must be DENIED: if the
  # prefix test leaked, it would be allowed.
  [[ "$(gate_path_verdict "${tmp}-backup/impl.ts")" == "deny" ]] && pass "look-alike sibling dir is NOT exempt" || fail "S25j sibling dir exempted"
  [[ "$(gate_path_verdict "$tmp/../escaped.ts")" == "deny" ]] && pass "a .. path cannot walk out of the exemption" || fail "S25j traversal exempted"
  teardown_state "$tmp"
fi

## S26 axis rules wiring + user_wrote telemetry
if should_run 26; then
  header "S26 axis rules + user_wrote telemetry"

  # 26a — while immersive, the context must point at the immersive rule
  # files and explicitly retire the level/mode ones, which are all
  # instructions about how to write code.
  tmp=$(setup_state 26a)
  set_level "$tmp" 3
  OUT=$(fire_pre "$tmp" "quiero agregar validacion al login")
  echo "$OUT" | grep -q "level-3-architect.md" && pass "rules line points at the level file" || fail "S26a level rules not referenced"
  echo "$OUT" | grep -q "axis.md + ladder.md" && pass "rules line points at axis + ladder" || fail "S26a axis rules not referenced"
  echo "$OUT" | grep -q "user_wrote" && pass "META PROTOCOL requests user_wrote where the user writes" || fail "S26a user_wrote not requested"

  # 26b — user_wrote is telemetry about the USER authoring. At L1 and L6
  # the agent authors, so asking for it would produce a column of `false`
  # that means nothing, and "no data" and "the user wrote nothing" are
  # different facts.
  set_level "$tmp" 1
  OUT=$(fire_pre "$tmp" "quiero agregar validacion al login")
  echo "$OUT" | grep -q "user_wrote" && fail "S26b user_wrote requested at L1" || pass "no user_wrote request at L1"
  echo "$OUT" | grep -q "level-1-implementer.md" && pass "L1 rules line restored" || fail "S26b L1 rules line missing"
  set_level "$tmp" 6
  fire_pre "$tmp" "x" | grep -q "user_wrote" && fail "S26b user_wrote requested at L6" || pass "no user_wrote request at L6"
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
  LADDER="$PLUGIN_DIR/skills/socratic/rules/ladder.md"
  RULES="$PLUGIN_DIR/skills/socratic/rules/axis.md"
  [[ -f "$LADDER" && -f "$RULES" ]] && pass "axis rule files exist" || fail "S26d rule files missing"
  grep -q "copy your response into their editor" "$LADDER" && pass "ladder states the copy-paste litmus test" || fail "S26d litmus test missing"
  grep -q "IS NOT" "$LADDER" && pass "ladder defines what a work order is NOT" || fail "S26d work order negative definition missing"
  grep -q -i "do not moralize" "$RULES" && pass "rules forbid moralizing about the escape" || fail "S26d escape moralizing rule missing"
fi

## S27 autonomy report: per-repo baseline, measurement, honesty
if should_run 27; then
  header "S27 autonomy report"

  # Claude Code sends a NATIVE path in the hook payload. These tests must
  # too: an MSYS path (/tmp/...) is not resolvable by node, repoRoot
  # returns null, and the baseline would silently never capture — which
  # would make every assertion here vacuously "not measured".
  winpath() { cygpath -m "$1" 2>/dev/null || echo "$1"; }

  repoA="${TEST_ROOT}/repo-27a"
  repoB="${TEST_ROOT}/repo-27b"
  for d in "$repoA" "$repoB"; do
    mkdir -p "$d"
    ( cd "$d" && git init -q . && git config user.email t@t && git config user.name t &&
      printf 'base\n' > README.md && git add . && git commit -qm base ) >/dev/null 2>&1
  done

  fire_cwd() {
    local tmp="$1"; local dir="$2"; local w
    w=$(winpath "$dir")
    SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/hook-pre-prompt.sh" >/dev/null 2>&1 <<EOF
{"prompt":"seguimos","cwd":"$w","hook_event_name":"UserPromptSubmit"}
EOF
  }
  run_status() {
    local tmp="$1"; local dir="$2"
    ( cd "$dir" && SOCRATIC_STATE_DIR="$tmp" SOCRATIC_CWD="$(winpath "$dir")" bun run "$SCRIPTS/status.ts" 2>&1 )
  }

  # 27a — THE v0.4 BUG. The old baseline was captured once, when
  # immersive was switched on, in whatever directory that happened to be.
  # A user who then worked in another project got an honest "+0 lines"
  # about a tree nobody had touched. Baselines are per-repo now, and the
  # hook refreshes the one for wherever the user actually is.
  tmp=$(setup_state 27a); set_level "$tmp" 3
  fire_cwd "$tmp" "$repoA"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit(Object.keys(d.git_baselines||{}).length===1?0:1)' "$tmp/profile.json" \
    && pass "first turn captures a baseline for the current repo" || fail "S27a no baseline captured"
  fire_cwd "$tmp" "$repoB"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit(Object.keys(d.git_baselines||{}).length===2?0:1)' "$tmp/profile.json" \
    && pass "switching projects captures its own baseline" || fail "S27a second repo not captured"

  # 27b — the formula has to survive a mid-session commit. Committing
  # moves HEAD and resets the working-tree diff, so a naive "diff now
  # minus diff then" goes NEGATIVE exactly when the user was most
  # productive. And an untracked file is invisible to `git diff HEAD`,
  # which is the common case when starting something new.
  printf 'l1\nl2\nl3\nl4\nl5\n' > "$repoA/mine.js"
  ( cd "$repoA" && git add . && git commit -qm work ) >/dev/null 2>&1
  printf 'l6\nl7\nl8\n' >> "$repoA/mine.js"
  printf 'x\n' > "$repoA/untracked.js"

  OUT=$(run_status "$tmp" "$repoA")
  echo "$OUT" | grep -q "you wrote: +9" && pass "counts committed + pending + untracked" || fail "S27b wrong count: $(echo "$OUT" | grep 'you wrote')"
  echo "$OUT" | grep -q "repo-27a" && pass "names the repo it measured" || fail "S27b repo not named"

  # 27c — and the other repo keeps its own number.
  OUT=$(run_status "$tmp" "$repoB")
  echo "$OUT" | grep -q "you wrote: +0" && pass "each repo measures its own tree" || fail "S27c trees mixed: $(echo "$OUT" | grep 'you wrote')"

  # 27d — the agent's own lines are subtracted. Unlike an escape, the
  # gate saw every file it allowed and counted the lines, so here the
  # user's number can actually be theirs.
  node -e '
    const fs=require("fs"); const p=process.argv[1];
    const d=JSON.parse(fs.readFileSync(p,"utf-8"));
    d.axis_budget={date:new Date().toISOString().slice(0,10),files_used:1,lines_written:4};
    fs.writeFileSync(p,JSON.stringify(d));' "$tmp/profile.json"
  OUT=$(run_status "$tmp" "$repoA")
  echo "$OUT" | grep -q "you wrote: +5" && pass "subtracts the agent's 4 lines (9-4=5)" || fail "S27d no subtraction: $(echo "$OUT" | grep 'you wrote')"
  echo "$OUT" | grep -q "excluded from the count above" && pass "states the subtraction" || fail "S27d subtraction not disclosed"

  # 27e — an escape cannot be attributed: its work lands in the same
  # working tree as the user's. Saying so is cheaper than a wrong number
  # the user might trust.
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/escape.ts" --reason "prod incident" --minutes 10 >/dev/null 2>&1
  OUT=$(run_status "$tmp" "$repoA")
  echo "$OUT" | grep -q "included in the line count above" && pass "discloses escape contamination" || fail "S27e contamination not disclosed"
  echo "$OUT" | grep -q "prod incident" && pass "the escape reason is shown" || fail "S27e escape reason missing"
  teardown_state "$tmp"

  # 27f — outside a git repo it degrades to the soft signals instead of
  # failing, and never prints a zero that actually means "not measured".
  nonrepo="${TEST_ROOT}/nonrepo-27"; mkdir -p "$nonrepo"
  tmp=$(setup_state 27f); set_level "$tmp" 3
  OUT=$(run_status "$tmp" "$nonrepo")
  echo "$OUT" | grep -q "not measured" && pass "degrades cleanly outside a git repo" || fail "S27f did not degrade cleanly"
  echo "$OUT" | grep -q "you wrote: +0" && fail "S27f printed a fake zero" || pass "does not print a zero it cannot justify"
  teardown_state "$tmp"

  # 27g — level 6 reports "not applicable", never a number. A zero that
  # really means "not measured" is the dishonest datum this report was
  # built not to produce.
  tmp=$(setup_state 27g); set_level "$tmp" 6
  OUT=$(run_status "$tmp" "$repoA")
  echo "$OUT" | grep -q "not applicable" && pass "level 6 reports not-applicable" || fail "S27g L6 reported a number"
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

  # 28e — a build drill below level 3 is not a drill: the agent would
  # simply write the bodies and the exercise would measure nothing.
  tmp=$(setup_state 28e); set_level "$tmp" 2
  ERR=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --kind build 2>&1 )
  echo "$ERR" | grep -q "needs level 3 or higher" && pass "build drill requires level 3+" || fail "S28e build allowed below level 3"
  # The off ramp is not "even higher" — it is the axis switched off.
  set_level "$tmp" 6
  ERR=$( cd "$repo" && SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/drill.ts" --kind build 2>&1 )
  echo "$ERR" | grep -q "needs level 3 or higher" && pass "build drill refused on the off ramp" || fail "S28e build allowed at level 6"

  # 28f — at level 3+ the build drill measures what the user wrote.
  set_level "$tmp" 3
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

## S29 authorship layers: create-vs-edit, shape, daily budget
if should_run 29; then
  header "S29 authorship layers (shape + budget)"

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
  gate_reason() {
    local tmp="$1"; local path="$2"; local content="$3"
    node -e '
      process.stdout.write(JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: process.argv[1], content: process.argv[2] },
        hook_event_name: "PreToolUse",
      }));
    ' "$path" "$content" | SOCRATIC_STATE_DIR="$tmp" bash "$SCRIPTS/hook-pre-tool.sh"
  }

  work="${TEST_ROOT}/work-29"
  mkdir -p "$work"

  SKEL='import { db } from "./db"

export interface User {
  id: string
  email: string
}

// TODO: look the user up by email
export function findUser(email: string): User | null
'
  IMPL='export function findUser(email: string): User | null {
  const rows = db.query("select * from users", [email])
  if (rows.length === 0) return null
  return rows[0]
}
'

  # --- LAYER 1: create vs edit ---------------------------------------------
  # The only authorship boundary that can be drawn without anyone's
  # opinion. "Is this boilerplate or the code that teaches them?" is a
  # judgment call; whether a file already exists is a fact.
  tmp=$(setup_state 29a)
  set_level "$tmp" 3
  [[ "$(gate_write "$tmp" "$work/fresh.ts" "$SKEL")" == "allow" ]] && pass "creating a skeleton is allowed" || fail "S29a skeleton denied"
  touch "$work/already.ts"
  [[ "$(gate_write "$tmp" "$work/already.ts" "$SKEL")" == "deny" ]] && pass "writing over an existing file is denied" || fail "S29a existing-file write allowed"
  [[ "$(gate_write "$tmp" "$work/already.ts" "$SKEL" Edit)" == "deny" ]] && pass "Edit stays denied" || fail "S29a Edit allowed"
  teardown_state "$tmp"

  # --- LAYER 2: shape -------------------------------------------------------
  # THE RU-3 HOLE. Nothing in layer 1 stops the agent from creating a file
  # that does not exist and putting the whole implementation in it. The
  # check does not try to DETECT an implementation (open-ended, and the
  # model can out-invent any blacklist) — it asserts the closed property
  # "this has the shape of a skeleton", with STATEMENT as the residual
  # category so unknown syntax fails closed.
  tmp=$(setup_state 29b)
  set_level "$tmp" 3
  [[ "$(gate_write "$tmp" "$work/impl.ts" "$IMPL")" == "deny" ]] && pass "a new file carrying an implementation is DENIED" || fail "S29b the RU-3 hole is open"
  gate_reason "$tmp" "$work/impl.ts" "$IMPL" | grep -q "executable statement" && pass "denial names the statement count" || fail "S29b shape denial is not actionable"
  [[ "$(gate_write "$tmp" "$work/one.ts" 'export function f(): void { doIt() }')" == "deny" ]] && pass "a body smuggled onto the signature line is denied" || fail "S29b inline body allowed"
  # Statements packed behind semicolons must not slip under a per-line count.
  [[ "$(gate_write "$tmp" "$work/packed.ts" 'function f(){ const a=1; const b=2; const c=3; return a+b+c }')" == "deny" ]] && pass "semicolon-packed statements still count" || fail "S29b packing evades the budget"

  # Markup has no bodies to leave empty, so it is judged by the line cap
  # alone — a statement budget would deny every honest scaffold.
  [[ "$(gate_write "$tmp" "$work/index.html" '<!doctype html>
<html><body><div id="root"></div></body></html>')" == "allow" ]] && pass "html skeleton allowed" || fail "S29b html denied"
  [[ "$(gate_write "$tmp" "$work/package.json" '{"name":"app","scripts":{"dev":"vite"}}')" == "allow" ]] && pass "package.json allowed" || fail "S29b package.json denied"

  # The line cap still bounds a file that is all comments/declarations.
  #
  # Generated with shell builtins, NOT `node -e`: under Git Bash, MSYS
  # argument conversion rewrites a `-e` payload containing `//` or `\n`
  # as if it were a path ("// line " becomes "/ line ", "\n" becomes
  # "/n"), so the fixture silently collapses to a single line and the
  # assertion tests nothing.
  BIG=""
  for i in $(seq 1 120); do BIG="${BIG}// line ${i}"$'\n'; done
  [[ "$(gate_write "$tmp" "$work/big.ts" "$BIG")" == "deny" ]] && pass "line cap denies an oversized file" || fail "S29b line cap not enforced"
  teardown_state "$tmp"

  # --- L2 allows trivial bodies --------------------------------------------
  # The split is not "easy vs hard", it is "load-bearing vs not". L2 gets a
  # small allowance so plumbing does not have to be typed by hand.
  tmp=$(setup_state 29c)
  set_level "$tmp" 2
  [[ "$(gate_write "$tmp" "$work/trivial.ts" 'export class Repo {
  private db: Db

  getId(u: User): string {
    return u.id
  }
}')" == "allow" ]] && pass "L2 allows trivial bodies" || fail "S29c L2 denied a trivial body"
  teardown_state "$tmp"

  # --- LAYER 3: daily budget ------------------------------------------------
  # Does not prevent, it bounds the blast radius. Replaces the v0.4
  # user-granted window: the gate never needed the model's opinion, only a
  # fact and a counter.
  tmp=$(setup_state 29d)
  set_level "$tmp" 5   # 3 files/day
  for i in 1 2 3; do gate_write "$tmp" "$work/b$i.ts" "$SKEL" > /dev/null; done
  USED=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.stdout.write(String(d.axis_budget && d.axis_budget.files_used))' "$tmp/profile.json")
  [[ "$USED" == "3" ]] && pass "allowed writes charge the budget" || fail "S29d budget not charged (got $USED)"
  [[ "$(gate_write "$tmp" "$work/b4.ts" "$SKEL")" == "deny" ]] && pass "the 4th file is denied on a 3-file budget" || fail "S29d budget not enforced"
  gate_reason "$tmp" "$work/b4.ts" "$SKEL" | grep -q "resets tomorrow" && pass "denial says when it resets" || fail "S29d budget denial unclear"

  # A denial must never charge: being told no is not a use of the budget.
  BEFORE=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.stdout.write(String(d.axis_budget.files_used))' "$tmp/profile.json")
  gate_write "$tmp" "$work/b5.ts" "$IMPL" > /dev/null
  AFTER=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.stdout.write(String(d.axis_budget.files_used))' "$tmp/profile.json")
  [[ "$BEFORE" == "$AFTER" ]] && pass "a denial does not consume budget (I4)" || fail "S29d denial charged the budget"

  # Yesterday's budget is spent, not carried.
  node -e '
    const fs=require("fs"); const p=process.argv[1];
    const d=JSON.parse(fs.readFileSync(p,"utf-8"));
    d.axis_budget.date = "2020-01-01";
    fs.writeFileSync(p, JSON.stringify(d));' "$tmp/profile.json"
  [[ "$(gate_write "$tmp" "$work/b6.ts" "$SKEL")" == "allow" ]] && pass "budget resets on a new UTC day" || fail "S29d stale budget still blocking"
  teardown_state "$tmp"

  # 29e — the rules must forbid inferring permission from prose.
  RULES="$PLUGIN_DIR/skills/socratic/rules/axis.md"
  # Substring must not span a line wrap: the rule is prose and gets
  # rewrapped whenever the file is edited.
  grep -q "treat prose as permission" "$RULES" && pass "rules forbid inferring a grant from prose" || fail "S29e prose rule missing"
  grep -q -i "suggest" "$RULES" && pass "rules allow suggesting the command" || fail "S29e suggestion rule missing"
fi

## S30 the axis: level contract, off ramp, budget, escape
if should_run 30; then
  header "S30 axis contract"

  # 30a — data/levels.json and the in-code FALLBACK must agree. The
  # "single source of truth" claim rots silently otherwise: the JSON is
  # what ships, the FALLBACK is what runs when the JSON is unreadable,
  # and a drift between them would only surface on a broken install.
  bun run "$PLUGIN_DIR/tests/fixtures/axis-contract.ts" > /dev/null 2>&1 \
    && pass "levels.json matches the in-code FALLBACK" \
    || fail "S30a levels.json and FALLBACK disagree"

  # 30b-g — behavioral checks. They live in a fixture because bun does
  # not resolve MSYS paths inside an import string, and $SCRIPTS is
  # exactly that under Git Bash.
  AXIS_OUT=$(bun run "$PLUGIN_DIR/tests/fixtures/axis-behavior.ts" 2>&1)

  # R6.1: an automatic path must never land on the off ramp. A plugin
  # that promotes you to "the agent does everything" sabotages itself.
  echo "$AXIS_OUT" | grep -q "^clamp=OK$" \
    && pass "clampToAxis never reaches the off ramp" || fail "S30b clamp allows level 6"

  # readLevel PRESERVES 6. Every v0.4 reader open-coded min(5,max(1,n)),
  # which maps 6 to 5 — and under the new axis 5 means "writes nothing,
  # asks only", the exact opposite of 6. The user would get the most
  # restrictive setting believing they had switched the axis off, and
  # nothing would report an error.
  echo "$AXIS_OUT" | grep -q "^readlevel=OK$" \
    && pass "readLevel preserves the off ramp" || fail "S30c readLevel clamps 6 away"

  echo "$AXIS_OUT" | grep -q "^authorship=OK$" \
    && pass "edit/statement contract matches levels.json" || fail "S30d authorship contract drifted"

  # The level bounds the ladder; the rung still moves inside it.
  # Collapsing them would make getting stuck on one bug demote you.
  echo "$AXIS_OUT" | grep -q "^rung=OK$" \
    && pass "rung clamps into the level range" || fail "S30e rung range wrong"

  # Budget keyed by UTC: the suite has already been bitten once by local
  # dates (five asserts failing only between 17:00 and midnight, UTC-7).
  echo "$AXIS_OUT" | grep -q "^budget=OK$" \
    && pass "budget accumulates and resets on the UTC day" || fail "S30f budget wrong"

  # A gate that blocks real work by mistake gets uninstalled, so every
  # uncertain path has to end open.
  echo "$AXIS_OUT" | grep -q "^failopen=OK$" \
    && pass "L1, L6 and an open escape all disarm the gate" || fail "S30g fail-open path broken"
fi

## S31 migration v0.4.x -> v0.5
if should_run 31; then
  header "S31 profile migration"

  # 31a — THE dangerous case. Old L5 meant "write it for me and be
  # quiet"; new L5 means the opposite, and both read as "silent", so the
  # user would not notice until it hurt. L6 is bit-for-bit the old L5,
  # which is what makes this migration safe.
  tmp=$(setup_state 31a)
  printf '{"global_level":5,"mode":"productive","enabled":true}' > "$tmp/profile.json"
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/migrate-profile.ts" 2>&1)
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit((d.global_level===6 && d.schema_version===2 && d.mode===undefined && d.enabled===true)?0:1)' "$tmp/profile.json" \
    && pass "old L5 -> L6, mode dropped, schema stamped" || fail "S31a migration wrong"
  echo "$OUT" | grep -q "nivel 6" && pass "notice names level 6 (R6.5/M4)" || fail "S31a notice hides the level"
  echo "$OUT" | grep -q "1-5" && pass "notice says where the real axis lives" || fail "S31a notice omits the way back"

  # 31b — idempotent (M2). A second run is a silent noop, not a second
  # migration and not a second notice.
  OUT2=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/migrate-profile.ts" 2>&1)
  echo "$OUT2" | grep -q "nothing to do" && pass "second run is a noop" || fail "S31b migration not idempotent"
  teardown_state "$tmp"

  # 31c — an active immersive session already meant "the agent writes
  # nothing", which is L4 regardless of the level it was layered on.
  tmp=$(setup_state 31c)
  printf '{"global_level":2,"mode":"learn","immersive":{"active":true,"started_at":"2026-08-03T10:00:00.000Z","expires_at":null,"unlocks":[{"at":"2026-08-03T11:00:00.000Z","reason":"prod","minutes":10}],"baseline_hint":2,"git_baseline":{"repo":"/x","head":"abc","added":0,"removed":0}}}' > "$tmp/profile.json"
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/migrate-profile.ts" > /dev/null 2>&1
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit((d.global_level===4 && d.immersive===undefined && Array.isArray(d.escapes) && d.escapes.length===1 && d.git_baseline)?0:1)' "$tmp/profile.json" \
    && pass "active immersive -> L4, subtree flattened" || fail "S31c immersive migration wrong"
  teardown_state "$tmp"

  # 31d — identity mapping for the levels that keep their number.
  tmp=$(setup_state 31d)
  IDENT_OK=1
  for lvl in 1 2 3 4; do
    printf '{"global_level":%s}' "$lvl" > "$tmp/profile.json"
    SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/migrate-profile.ts" > /dev/null 2>&1
    node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit(d.global_level===Number(process.argv[2])?0:1)' "$tmp/profile.json" "$lvl" || IDENT_OK=0
  done
  [[ "$IDENT_OK" -eq 1 ]] && pass "levels 1-4 map to themselves" || fail "S31d identity mapping broken"
  teardown_state "$tmp"

  # 31e — refuses to touch a corrupt profile rather than overwriting it.
  tmp=$(setup_state 31e)
  printf 'not json at all' > "$tmp/profile.json"
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/migrate-profile.ts" > /dev/null 2>&1 \
    && fail "S31e migrated a corrupt profile" || pass "corrupt profile is refused, not overwritten"
  grep -q "not json at all" "$tmp/profile.json" && pass "corrupt profile left untouched" || fail "S31e corrupt profile was clobbered"
  teardown_state "$tmp"
fi

## S32 handoff: protocol wiring, unit continuity, evaluation rules
if should_run 32; then
  header "S32 guided handoff"

  # 32a — the protocol appears exactly where a unit changes hands, and
  # nowhere else. At L1 the agent writes; at L5 it does not direct the
  # work at all. Pointing at a handoff protocol there would invite the
  # model to invent one.
  tmp=$(setup_state 32a)
  set_level "$tmp" 3
  OUT=$(fire_pre "$tmp" "hagamos el login")
  echo "$OUT" | grep -q "HANDOFF PROTOCOL (by unit)" && pass "L3 announces the handoff protocol" || fail "S32a L3 missing handoff protocol"
  echo "$OUT" | grep -q "handoff.md" && pass "L3 rules line points at handoff.md" || fail "S32a handoff.md not referenced"
  echo "$OUT" | grep -q "STATE ACCEPTANCE CRITERIA before any code exists" && pass "criteria-first is stated" || fail "S32a criteria-first missing"

  set_level "$tmp" 2
  OUT=$(fire_pre "$tmp" "hagamos el login")
  echo "$OUT" | grep -q "HANDOFF PROTOCOL (by module)" && pass "L2 hands off by module" || fail "S32a L2 handoff unit wrong"

  set_level "$tmp" 4
  OUT=$(fire_pre "$tmp" "hagamos el login")
  echo "$OUT" | grep -q "HANDOFF PROTOCOL (by subproblem)" && pass "L4 hands off by subproblem" || fail "S32a L4 handoff unit wrong"

  set_level "$tmp" 5
  OUT=$(fire_pre "$tmp" "hagamos el login")
  echo "$OUT" | grep -q "HANDOFF PROTOCOL" && fail "S32a L5 leaked a handoff protocol" || pass "L5 has no handoff (it does not direct)"
  echo "$OUT" | grep -q "You do NOT direct the work at this level" && pass "L5 is told not to decompose" || fail "S32a L5 missing the no-direction rule"

  set_level "$tmp" 1
  OUT=$(fire_pre "$tmp" "hagamos el login")
  echo "$OUT" | grep -q "HANDOFF PROTOCOL" && fail "S32a L1 leaked a handoff protocol" || pass "L1 has no handoff (the agent writes)"
  teardown_state "$tmp"

  # 32b — the statement allowance is announced with the real number, so
  # the model is not left to guess what the gate will accept.
  tmp=$(setup_state 32b)
  set_level "$tmp" 3
  fire_pre "$tmp" "x" | grep -q "ZERO executable statements" && pass "L3 announces a zero statement allowance" || fail "S32b L3 allowance not announced"
  set_level "$tmp" 2
  fire_pre "$tmp" "x" | grep -q "at most 8 executable statements" && pass "L2 announces its allowance" || fail "S32b L2 allowance not announced"
  teardown_state "$tmp"

  # 32c — a unit in flight survives across turns. Without this the
  # protocol degrades into "frame everything, then chat".
  tmp=$(setup_state 32c)
  set_level "$tmp" 3
  SDOC="$tmp/sessions/$(date -u +%Y-%m-%d).json"
  node -e '
    const fs=require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
      date: process.argv[2], turns: [],
      handoff: { unit: "validateCredentials", criteria: ["rejects empty email","same error for both cases"], opened_at: "2026-09-01T10:00:00Z" },
    }));' "$SDOC" "$(date -u +%Y-%m-%d)"
  OUT=$(fire_pre "$tmp" "ya la escribi")
  echo "$OUT" | grep -q 'UNIT IN FLIGHT: "validateCredentials"' && pass "the unit in flight is announced" || fail "S32c unit not announced"
  echo "$OUT" | grep -q "rejects empty email" && pass "the stated criteria come back with it" || fail "S32c criteria not echoed"
  echo "$OUT" | grep -q "Do NOT hand over another unit" && pass "a second unit is forbidden while one is open" || fail "S32c concurrent units allowed"
  teardown_state "$tmp"

  # 32d — HINT_META.handoff opens and closes the unit.
  tmp=$(setup_state 32d)
  set_level "$tmp" 3
  fire_stop "$tmp" "dale" 'Arranquemos.
<!-- HINT_META {"topic":"auth","correct":null,"hintLevel":3,"handoff":{"unit":"issueSession","criteria":["not guessable from the user id"]}} /HINT_META -->'
  SDOC="$tmp/sessions/$(date -u +%Y-%m-%d).json"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit((d.handoff && d.handoff.unit==="issueSession" && d.handoff.criteria.length===1)?0:1)' "$SDOC" \
    && pass "HINT_META opens the handoff" || fail "S32d handoff not persisted"

  # A second open must NOT overwrite: one unit at a time, and the first
  # is the one the user is still working on.
  fire_stop "$tmp" "seguimos" 'Otra mas.
<!-- HINT_META {"topic":"auth","correct":null,"hintLevel":3,"handoff":{"unit":"otherThing","criteria":[]}} /HINT_META -->'
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit(d.handoff.unit==="issueSession"?0:1)' "$SDOC" \
    && pass "a second open does not displace the unit in flight" || fail "S32d handoff overwritten"

  fire_stop "$tmp" "aca esta" 'Cumple los criterios.
<!-- HINT_META {"topic":"auth","correct":true,"hintLevel":3,"handoff":"close"} /HINT_META -->'
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit(d.handoff===undefined?0:1)' "$SDOC" \
    && pass '"close" clears the unit' || fail "S32d close did not clear"

  # A malformed handoff must degrade to "nothing changed hands", never
  # cost the whole turn record.
  BEFORE=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.stdout.write(String(d.turns.length))' "$SDOC")
  fire_stop "$tmp" "x" 'Texto.
<!-- HINT_META {"topic":"auth","correct":null,"hintLevel":3,"handoff":{"criteria":["no unit name"]}} /HINT_META -->'
  AFTER=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.stdout.write(String(d.turns.length))' "$SDOC")
  [[ "$AFTER" -gt "$BEFORE" ]] && pass "a malformed handoff still records the turn" || fail "S32d malformed handoff lost the turn"
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")); process.exit(d.handoff===undefined?0:1)' "$SDOC" \
    && pass "a handoff with no unit name is ignored" || fail "S32d nameless handoff accepted"
  teardown_state "$tmp"

  # 32e — the evaluation rules must carry their load-bearing sentences.
  # These are the ones that stop "review" from decaying into "looks good".
  RULES="$PLUGIN_DIR/skills/socratic/rules/handoff.md"
  [[ -f "$RULES" ]] && pass "handoff.md exists" || fail "S32e handoff.md missing"
  grep -q "Point at the line" "$RULES" && pass "evaluation demands a specific line" || fail "S32e line-pointing rule missing"
  grep -q "Do not produce the corrected version" "$RULES" && pass "rewriting the fix is forbidden" || fail "S32e no-rewrite rule missing"
  grep -q -i "softening" "$RULES" && pass "softening is named as a failure" || fail "S32e softening not named"
  grep -q "copy your response into their editor" "$RULES" && pass "the litmus test is restated for prose" || fail "S32e litmus test missing"
  grep -q -i "do not close the unit" "$RULES" && pass "a failed unit is handed back, not fixed" || fail "S32e hand-back rule missing"
fi

## S34 harness invariant: day keys are UTC, never local
if should_run 34; then
  header "S34 UTC day-key invariant"

  # WHY THIS EXISTS. Five asserts once failed together with no code
  # change behind them: the tests resolved session-file paths with
  # `date` (LOCAL) while the scripts write them with toISOString()
  # (UTC). At 22:34 local in a UTC-7 zone it was already the next day
  # in UTC, so the scripts wrote one file and the tests read another.
  # The failure window was 17:00 to midnight, every day, and it stayed
  # latent for two phases because nobody ran the suite in that band.
  #
  # Asserting the invariant statically beats remembering to run the
  # suite at the right hour — which is the only other way to catch it,
  # and is not a plan.
  # The pattern is written with character classes so this check cannot
  # match its own source line — a self-match would make it fail forever
  # and teach whoever inherits it to delete the check.
  BAD=$(grep -n '[$](date [+]%Y-%m-%d' "$PLUGIN_DIR/tests/run-all.sh" || true)
  [[ -z "$BAD" ]] && pass "no assert resolves a day key with local time" \
    || fail "S34 local date used for a day key: $BAD"

  BAD=$(grep -rn 'toLocaleDateString\|getFullYear()' "$SCRIPTS" --include=*.ts || true)
  [[ -z "$BAD" ]] && pass "no script derives a day key from local time" \
    || fail "S34 local date in scripts: $BAD"

  # And the two producers must agree on the format.
  KEY=$(bun run "$PLUGIN_DIR/tests/fixtures/daykey-probe.ts")
  [[ "$KEY" == "$(date -u +%Y-%m-%d)" ]] && pass "Axis.dayKey matches date -u" \
    || fail "S34 dayKey mismatch: $KEY vs $(date -u +%Y-%m-%d)"
fi

## S33 status: one control panel
if should_run 33; then
  header "S33 unified status"

  # v0.4 answered "what is my setup?" across four places — the level, the
  # mode, whether immersive was on, whether a scaffold window was open —
  # and a user who wanted less help had to know which one to move. One
  # axis, one panel.
  tmp=$(setup_state 33); set_level "$tmp" 3
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/status.ts" 2>&1)
  echo "$OUT" | grep -q "level 3 — Architect" && pass "names the level and its role" || fail "S33 level line missing"
  echo "$OUT" | grep -q "agent may create new files: 6 left today" && pass "shows the remaining budget" || fail "S33 budget missing"
  echo "$OUT" | grep -q "may NOT edit files that already exist" && pass "states the authorship boundary" || fail "S33 boundary missing"
  echo "$OUT" | grep -q "handoff by unit" && pass "shows the handoff unit" || fail "S33 handoff missing"
  echo "$OUT" | grep -q "episode: none" && pass "reports no episode" || fail "S33 episode line missing"
  echo "$OUT" | grep -q "^autonomy" && pass "includes the autonomy report" || fail "S33 autonomy section missing"
  echo "$OUT" | grep -qi "mode:" && fail "S33 mode leaked into status" || pass "no mode line (it no longer exists)"
  echo "$OUT" | grep -qi "immersive" && fail "S33 immersive leaked into status" || pass "no immersive line"

  # An episode in flight shows up in exactly one place.
  SDOC="$tmp/sessions/$(date -u +%Y-%m-%d).json"
  node -e '
    const fs=require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
      date: process.argv[2], turns: [],
      feynman: { topic: "closures", started_at: "2026-09-01T10:00:00Z", gaps: ["x"] },
      handoff: { unit: "validateCredentials", criteria: [], opened_at: "2026-09-01T10:00:00Z" },
    }));' "$SDOC" "$(date -u +%Y-%m-%d)"
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/status.ts" 2>&1)
  echo "$OUT" | grep -q 'feynman teaching "closures"' && pass "shows an active feynman episode" || fail "S33 feynman not shown"
  echo "$OUT" | grep -q 'unit in flight: "validateCredentials"' && pass "shows the unit in flight" || fail "S33 handoff not shown"

  # An open escape is visible with its reason and remaining time.
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/escape.ts" --reason "prod incident" --minutes 10 >/dev/null 2>&1
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/status.ts" 2>&1)
  echo "$OUT" | grep -q "escape OPEN" && pass "shows an open escape" || fail "S33 escape not shown"
  echo "$OUT" | grep -q "prod incident" && pass "shows the escape reason" || fail "S33 escape reason missing"
  teardown_state "$tmp"

  # R6.5: the off ramp is ALWAYS reported by name. Keeping it out of the
  # user docs discourages discovery; it does not license hiding the state
  # from someone who already turned it on.
  tmp=$(setup_state 33b); set_level "$tmp" 6
  OUT=$(SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/status.ts" 2>&1)
  echo "$OUT" | grep -q "level 6 — Autopilot" && pass "level 6 is reported by name" || fail "S33b L6 hidden from status"
  echo "$OUT" | grep -q "the axis is OFF" && pass "level 6 says what it implies" || fail "S33b L6 implication missing"
  echo "$OUT" | grep -q "levels 1-5" && pass "level 6 says where the axis lives" || fail "S33b way back missing"
  teardown_state "$tmp"

  # The kill switches own the whole output; there is nothing to add.
  tmp=$(setup_state 33c); set_level "$tmp" 3
  node -e 'const fs=require("fs"),p=process.argv[1];const d=JSON.parse(fs.readFileSync(p,"utf-8"));d.enabled=false;fs.writeFileSync(p,JSON.stringify(d));' "$tmp/profile.json"
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/status.ts" 2>&1 | grep -q "DISABLED" && pass "disabled is reported plainly" || fail "S33c disabled not reported"
  mv "$tmp/profile.json" "$tmp/profile.json.paused"
  SOCRATIC_STATE_DIR="$tmp" bun run "$SCRIPTS/status.ts" 2>&1 | grep -q "PAUSED" && pass "paused is reported plainly" || fail "S33c paused not reported"
  teardown_state "$tmp"
fi

# ==========================================================================
summary
[[ "$FAIL_COUNT" -eq 0 ]]
