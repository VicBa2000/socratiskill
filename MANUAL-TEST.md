# Socratiskill — manual E2E test plan

Five scenarios (+ one sanity check) to validate the plugin in a clean
install before release. Each test is marked PASS if the observed result
matches the expected one.

> **Prerequisite for every test**: run
> `bash scripts/install.sh` and then, in a fresh
> Claude Code session:
>
> ```
> /plugin marketplace add <path-to-repo>
> /plugin install socratiskill@socratiskill
> /reload-plugins
> ```

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

1. `/socratiskill:socratic` -> confirm current level (e.g. 3, base hint=0).
2. Start a technical conversation where you answer the same topic
   wrong twice on purpose (e.g. "difference between map and forEach?"
   -> give a wrong answer twice). The model should close each turn
   with HINT_META `correct:false` on the same topic.
3. On the third turn, ask another question on the same topic.
   **Expected**: the `SOCRATIC CONTEXT` block (visible only if you
   inspect it in debug mode) shows `hint: 1+ (...)` — it went up.
   Easy behavioral check: the model's response style becomes more
   direct (scaffolding increases).
4. Inspect `~/.claude/socratic/sessions/<date>.json`:
   - `hint_state.consecutiveFailures >= 1`
   - `hint_state.currentLevel >= 1`

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

## Extra sanity: toggle off/on

1. ```
   /socratiskill:socratic off
   ```
   Response: `socratiskill: disabled`.
2. Any prompt. If you have a debug toggle that exposes system-reminders,
   SOCRATIC CONTEXT does not appear. The model responds as vanilla
   Claude Code.
3. ```
   /socratiskill:socratic on
   ```
4. New prompt: SOCRATIC CONTEXT is injected again.

---

## If something fails

File an issue with: (1) scenario + step, (2) expected vs. observed,
(3) contents of the relevant files (`profile.json`, the latest
session file, `antipatterns.json`), (4) versions of Claude Code and
bun.
