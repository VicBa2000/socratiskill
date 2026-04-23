# Socratiskill — manual E2E test plan

Eight scenarios (+ one sanity check) to validate the plugin in a clean
install before release. Each test is marked PASS if the observed result
matches the expected one.

> **Prerequisite for every test**: in a fresh Claude Code session,
>
> ```
> /plugin marketplace add <path-to-repo>
> /plugin install socratiskill@socratiskill
> /reload-plugins
> ```
>
> The plugin manifest (`hooks/hooks.json`) registers the
> `UserPromptSubmit` and `Stop` hooks automatically. **`bash
> scripts/install.sh` is no longer required** — it remains as a
> legacy fallback for users who do not install via the plugin system.
> Profile is created on first `calibrate`.

---

## Scenario 1 — Fresh calibrate

**Goal**: a new user runs calibrate and the level is persisted.

1. Backup + reset the state:
   ```bash
   mv ~/.claude/socratic ~/.claude/socratic.bak 2>/dev/null || true
   bash scripts/install.sh
   ```
2. In Claude Code:
   ```
   /socratiskill:socratic calibrate
   ```
   **Expected**: "Welcome to Socratiskill" message + 5 options.
3. Respond `3` (Intermediate).
   **Expected**: "calibration complete: level 3 (Pair programmer)".
4. ```
   /socratiskill:socratic status
   ```
   **Expected**: `enabled: true`, `level: 3`, `calibrated: true`,
   `calibration_date` present in profile.json.
5. Restore the backup:
   ```bash
   rm -rf ~/.claude/socratic && mv ~/.claude/socratic.bak ~/.claude/socratic
   ```

---

## Scenario 2 — Hint escalates after failures

**Goal**: two consecutive wrong answers about the same topic raise
the hint_level.

1. `/socratiskill:socratic` -> confirm current level (e.g. 3, base
   hint=2 — see the "Initial hint level per user level" table in
   `skills/socratic/rules/hint-ladder.md`: L1=5, L2=4, L3=2, L4=1,
   L5=0).
2. Start a technical conversation where you answer the same topic
   wrong twice on purpose (e.g. "difference between map and forEach?"
   -> give a wrong answer twice). The model should close each turn
   with HINT_META `correct:false` on the same topic.
3. On the third turn, ask another question on the same topic.
   **Expected**: the `SOCRATIC CONTEXT` block (visible only if you
   inspect it in debug mode) shows a hint level one step above the
   initial — for L3 that is `hint: 3 (...)` after two wrong turns.
   Easy behavioral check: the model's response style becomes more
   direct (scaffolding increases).
4. Inspect `~/.claude/socratic/sessions/<date>.json`:
   - `hint_state.consecutiveFailures >= 1`
   - `hint_state.currentLevel >` the initial value for your level.

---

## Scenario 3 — Feynman mode inverts the role

**Goal**: `teach` activates role inversion; `endteach` summarizes
gaps.

1. ```
   /socratiskill:socratic teach closures
   ```
   **Expected**: "teach mode on: closures / your next turn: YOU
   explain...".
2. Write an intentionally weak explanation of closures (e.g. "a
   closure is a function that remembers stuff from its outer scope").
   **Expected**: the model does **not** explain; it asks, probes,
   requests a concrete example or edge case.
3. Repeat for 2 more turns with weak explanations.
4. ```
   /socratiskill:socratic endteach
   ```
   **Expected**: "teach ended: closures (Nmin, K gaps)" followed by
   bullet points listing the detected gaps.
5. Inspect `sessions/<date>.json`:
   - `feynman_summaries[]` has 1 entry with `gap_count >= 1`.
   - `feynman` no longer exists in the doc.

---

## Scenario 4 — Deleting profile.json forces recalibrate

**Goal**: the model recognizes the user as new if there is no profile.

1. ```bash
   rm ~/.claude/socratic/profile.json
   ```
2. In Claude Code, open a fresh session and issue any prompt.
   **Expected**: the `UserPromptSubmit` hook runs but build-context
   does not emit SOCRATIC CONTEXT (profile missing -> fail-open). No
   injection.
3. ```
   /socratiskill:socratic
   ```
   **Expected**: the subcommand reads profile.json -> does not exist
   -> should fail gracefully or recreate. (Note: init-profile.sh is
   NOT run automatically; the user must run install.sh, or `status`
   itself could suggest it. If observed behavior differs from
   expected, open an issue to decide.)
4. ```
   bash scripts/init-profile.sh
   /socratiskill:socratic calibrate
   ```
   **Expected**: calibration flow starts cleanly.

---

## Scenario 5 — Journal week after real use

**Goal**: with >=3 days of continuous use, `journal week` shows
cross-session aggregates.

> This scenario needs real accumulated data. Skip it during a same-day
> smoke test.

1. Use the skill for 3+ days with 10+ turns per day: technical
   questions, `teach X`, correct and incorrect answers.
2. ```
   /socratiskill:socratic journal week
   ```
   **Expected**:
   - Header `# Weekly Journal — YYYY-Www (Monday to Sunday)`.
   - `## Summary` section with `sessions (files): >=3, turns: >=30`.
   - At least 3 topics in `Learned`.
   - At least 1 topic in `Struggled`.
   - `## Feynman teach sessions` with >=1 entry if you used teach.
   - `## Leitner snapshot` with cards distributed among due/upcoming/
     resolved.
3. Generated file: `~/.claude/socratic/journal/weekly-YYYY-Www.md`.

---

## Scenario 6 — Pause / resume (true bypass)

**Goal**: `pause` makes the plugin invisible at zero token cost; `resume`
restores it without losing state.

1. Confirm baseline:
   ```
   /socratiskill:socratic status
   ```
   Note your `level` and `enabled: true`.
2. ```
   /socratiskill:socratic pause
   ```
   **Expected**: `[paused] ... → ....paused / hook will short-circuit
   on next turn (zero token cost).` Verify on disk:
   ```bash
   ls ~/.claude/socratic/profile.json*
   ```
   You should see `profile.json.paused` and **no** `profile.json`.
3. Send any normal prompt (e.g. *"explicame closures"*).
   **Expected**: Claude responds as vanilla Claude Code — no
   restate/plan/teach/verify preamble, no `HINT_META` block. If you
   inspect system-reminders in debug mode, **no** `SOCRATIC CONTEXT`
   appears.
4. ```
   /socratiskill:socratic resume
   ```
   **Expected**: `[resumed] ... → profile.json / hook will inject
   SOCRATIC CONTEXT on next turn.` `profile.json` is back, `.paused`
   is gone.
5. Send another prompt. SOCRATIC CONTEXT is injected again. Your
   level / streak / error-map are intact.
6. **Idempotency check**: run `/socratiskill:socratic pause` twice in a
   row. Second invocation should respond `[noop] already paused`. Same
   for `resume`.

---

## Scenario 7 — Uninstall path-traversal guard

**Goal**: `uninstall.sh --purge` refuses to operate on dangerous
`SOCRATIC_STATE_DIR` values.

> This scenario uses synthetic environment variables; it does NOT
> touch your real state. Run from any shell.

1. Each of the following invocations must abort with exit 2 and a clear
   `[abort]` message, leaving the path intact:
   ```bash
   SOCRATIC_STATE_DIR=/ bash scripts/uninstall.sh --purge
   SOCRATIC_STATE_DIR="$HOME" bash scripts/uninstall.sh --purge
   SOCRATIC_STATE_DIR=/etc bash scripts/uninstall.sh --purge
   SOCRATIC_STATE_DIR="$HOME/Documents" bash scripts/uninstall.sh --purge
   SOCRATIC_STATE_DIR="$HOME/.claude/socratic/../../../tmp" bash scripts/uninstall.sh --purge
   ```
2. Each command should print one of:
   - `refusing to rm -rf a root-level / home path`
   - `must live under $HOME`
   - `must contain '.claude/socratic' segment`
   - `contains '..' path segment`
3. Verify your real state was not touched:
   ```bash
   ls ~/.claude/socratic/
   ```

---

## Scenario 8 — Per-level protocol block is injected and mode-sensitive

**Goal**: for L1-L4 the `SOCRATIC CONTEXT` block contains a
per-level protocol reinforcement; for L5 it does not. The
L2-L4 blocks change between `learn` and `productive`.

> Prerequisite: you can inspect the hook stdout. If your Claude
> Code build does not surface it, run the hook directly:
> ```bash
> echo '{"prompt":"test","hook_event_name":"UserPromptSubmit"}' | \
>   bash scripts/hook-pre-prompt.sh
> ```

1. `/socratiskill:socratic level 1` then fire a prompt.
   **Expected**: the block contains the line
   `--- LEVEL 1 HARD LIMITS (critical, not optional) ---`.
2. `/socratiskill:socratic level 2` + `mode learn` + fire a prompt.
   **Expected**: `--- LEVEL 2 PROTOCOL (learn, active) ---` +
   a rule about stating the WHY before non-trivial decisions.
3. `/socratiskill:socratic mode productive` (staying at L2).
   **Expected**: `--- LEVEL 2 PROTOCOL (productive, active) ---`
   with the attenuated version — no "comprehension question after
   each new block" rule.
4. Repeat for L3 and L4, switching between `learn` and `productive`.
   L3 `learn` must include "¿Qué enfoque tenés en mente?" and
   "gapped code". L3 `productive` must state "No gapped code" and
   "No preamble". L4 `learn` requires at least ONE challenge; L4
   `productive` flags only critical issues.
5. `/socratiskill:socratic level 5` + fire a prompt.
   **Expected**: NO `LEVEL N PROTOCOL` block. L5 is the silent
   colleague — default Claude Code behavior with only the
   telemetry footer.
6. Verify there is no leak:
   ```bash
   grep -c "LEVEL [1-5] " <(bash scripts/hook-pre-prompt.sh < ...)
   ```
   Each prompt should emit exactly 0 (at L5) or 1 (at L1-L4)
   protocol blocks — never 2.

---

## Extra sanity: toggle off/on (soft silencer)

1. ```
   /socratiskill:socratic off
   ```
   Response: `socratiskill: disabled`.
2. Any prompt. If you have a debug toggle that exposes system-reminders,
   `SOCRATIC CONTEXT: DISABLED.` appears (a short silencer that tells
   the model to behave as default Claude Code) — **not** the full
   pedagogical context. The model responds as vanilla Claude Code.
3. ```
   /socratiskill:socratic on
   ```
4. New prompt: full SOCRATIC CONTEXT is injected again.

> Note: `off` still costs ~30 tokens/turn for the silencer message.
> If you want **zero** token cost, use `pause` instead (Scenario 6).

---

## If something fails

File an issue with: (1) scenario + step, (2) expected vs. observed,
(3) contents of the relevant files (`profile.json`, the latest
session file, `antipatterns.json`), (4) versions of Claude Code and
bun.
