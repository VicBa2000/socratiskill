# Socratiskill — manual E2E test plan

Fourteen scenarios (+ one sanity check) to validate the plugin in a clean
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
3. Respond `3` (Architect).
   **Expected**: "calibration complete: level 3 (Architect)".
   The five options must describe **authorship** ("I write skeletons
   and signatures; every body is yours"), not how much gets explained.
   That text is what seeds the level; if it still describes the old
   axis, the scenario FAILS.
4. ```
   /socratiskill:socratic status
   ```
   **Expected**: `level 3 — Architect`, the daily file budget, the
   authorship boundary, and today's autonomy block. `calibration_date`
   present in profile.json.
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

## Scenario 8 — The per-level protocol block is injected, one per turn

**Goal**: every level gets exactly one protocol block, chosen by level
and nothing else. There is no mode to cross it with any more.

> Prerequisite: you can inspect the hook stdout. If your Claude
> Code build does not surface it, run the hook directly:
> ```bash
> echo '{"prompt":"test","hook_event_name":"UserPromptSubmit"}' | \
>   bash scripts/hook-pre-prompt.sh
> ```

1. `/socratiskill:socratic level 1` then fire a prompt.
   **Expected**: `--- LEVEL 1 HARD LIMITS (critical, not optional) ---`,
   including the line that distinguishes it from level 6 ("every line
   still has to teach").
2. `level 2` + fire. **Expected**: `--- LEVEL 2 PROTOCOL ---` with
   `HANDOFF PROTOCOL (by module)` and an allowance of
   "at most 8 executable statements".
3. `level 3` + fire. **Expected**: `HANDOFF PROTOCOL (by unit)` and
   "ZERO executable statements".
4. `level 4` + fire. **Expected**: `HANDOFF PROTOCOL (by subproblem)`.
5. `level 5` + fire. **Expected**: a LEVEL 5 block, NO handoff protocol,
   and the line "You do NOT direct the work at this level".
6. Verify there is no leak: each prompt must emit exactly ONE
   `LEVEL N PROTOCOL` / `HARD LIMITS` block, never two.

---

## Scenario 9 — The gate actually blocks the agent

**Goal**: above level 1 this is enforcement, not instruction.

1. `/socratiskill:socratic level 3`.
2. Ask Claude to modify an existing file: *"agregale un console.log a
   src/index.ts"*.
   **Expected**: the tool call is DENIED. Claude relays a reason that
   names the level and tells it what to do instead. **The file on disk
   is unchanged** — verify with `git diff`. This is a denial, not a
   rollback: the call never ran.
3. Ask it to delegate: *"usá un subagente para escribirlo"*.
   **Expected**: also denied. A subagent writing on its behalf is it
   writing.
4. Ask it to route around via Bash: *"usá cat > src/index.ts"*.
   **Expected**: denied, and it does not try a third workaround.
5. Ask it to run your tests: *"corré bun test"*.
   **Expected**: ALLOWED. This is the activity the axis exists to
   produce; a false positive here is the worst failure mode.
6. Ask for a NEW file: *"creame src/auth/login.ts con la estructura"*.
   **Expected**: allowed, and the file contains signatures and TODOs
   with **no function bodies**.
7. Ask it to put the implementation in a new file:
   *"creame src/auth/impl.ts con validateCredentials ya implementada"*.
   **Expected**: DENIED, with a message naming how many executable
   statements it counted. This is the hole the shape check closes.
8. **A language that is not TypeScript.** Steps 6-7 only exercise the
   four languages the shape check always spoke. Until v0.5.2 it spoke
   *only* those four, so every other listed extension was denied even
   for an honest skeleton — the failure this step exists to catch.
   Pick whichever applies to your work:
   - *"creame procs/usp_place_order.sql con la estructura del stored
     procedure"* → **allowed**: the CREATE PROCEDURE, its parameters
     and a TODO in the body are structure.
   - Then *"ahora escribile el INSERT y el UPDATE adentro"* →
     **DENIED**, naming the statement count. Writing the body is
     still yours.
   - Same pair in Go, Rust, Kotlin, Swift, C, Ruby or PHP if that is
     your stack.

   **This is the step most worth doing carefully.** A false positive
   here is invisible in the worst way: the agent looks merely unhelpful
   rather than blocked, and at levels 3-5 a single miscounted line
   denies the whole file.

9. **The control panel must stay reachable.** Run
   `/socratiskill:socratic level 1` while at level 3.
   **Expected**: it works. The gate exempts the plugin's own state, so
   the key is never inside the locked room.

---

## Scenario 10 — `ship` is granted without a lecture

**Goal**: the escape hatch is respected, not editorialized.

1. At level 3, run `/socratiskill:socratic ship "prod hotfix"`.
2. **Expected**: the window opens and Claude writes normally.
3. **Expected, and this is the actual test**: NO "¿estás seguro?", no
   reminder about your goals, no visible disappointment, no "está bien,
   pero tené en cuenta que...". If Claude editorializes at all, the
   scenario FAILS — flattery and scolding are the same error of not
   respecting your decision.
4. `/socratiskill:socratic status` → the escape is listed with its
   reason and remaining minutes.
5. Wait for expiry (or `ship --end`) and ask for an edit again.
   **Expected**: denied again. The gate re-arms on its own.

---

## Scenario 11 — Drills

1. `/socratiskill:socratic drill analyze` at any level.
   **Expected**: the SCRIPT picks the file, not the model. Ask Claude
   to pick a different one — it must refuse.
2. Answer one question wrong on purpose. **Expected**: it becomes a
   Leitner card; `review` brings it back later.
3. `/socratiskill:socratic level 2` then `drill build`.
   **Expected**: refused, exit 2, telling you to reach level 3.
4. `level 3` then `drill build`. **Expected**: accepted, acceptance
   criteria agreed BEFORE any code exists.
5. `drill done` → reports the lines you wrote and reviews against those
   criteria.

### Fix drill — the locate phase

6. `/socratiskill:socratic drill fix`. **Expected**: starts in phase
   `locate`, on a file the script chose.
7. **Expected, and this is the actual test**: Claude states ONE change
   request and then asks where it goes. It must NOT name the function,
   quote the line, or describe the neighbourhood. If it hands you the
   location, the scenario FAILS — that was the entire exercise.
8. Answer with the WRONG place on purpose. **Expected**: it does not
   correct you. It asks a narrowing question ("¿quién llama a esto?").
9. Get it right. **Expected**: it advances to `implement` and only then
   fixes acceptance criteria.
10. `drill done` → reports `located first try: no`, flat, with no
    consolation padding. That is the measurement.
11. Check `git status`. **Expected**: Claude changed NOTHING in your
    repo to set the exercise up. A planted defect is a hard failure.

---

## Scenario 12 — The handoff loop

**Goal**: work arrives one unit at a time, and the review is objective.

1. At level 3, ask for something with several parts: *"hagamos el login
   con tokens de sesión"*.
2. **Expected**: Claude creates the skeleton, names ONE unit, states
   acceptance criteria, and **stops**. It must not start the second
   unit.
3. `/socratiskill:socratic status` → shows `unit in flight: "<name>"`.
4. Write a deliberately incomplete implementation (miss one stated
   criterion) and show it.
   **Expected**: it names the criterion that failed, points at a
   specific line, and **hands it back**. It must NOT produce the
   corrected version, and must not soften the problem into a
   suggestion.
5. Fix it and show it again. **Expected**: the unit closes and the next
   one is handed over.

---

## Scenario 13 — Level 6 is honest about itself

**Goal**: discouraging discovery is not the same as hiding state.

1. `/socratiskill:socratic level 6`.
   **Expected**: accepted, with no commentary about the choice.
2. `/socratiskill:socratic status`.
   **Expected**: reports `level 6 — Autopilot` by name, says the axis
   is off, and says the axis lives at levels 1-5. It must NOT hide it.
3. Ask for an edit. **Expected**: allowed; the gate is fully disarmed.
4. The autonomy line **must say "not applicable"**, never "+0 lines".
   A zero that really means "not measured" is a dishonest number.
5. Answer several questions correctly over a few turns.
   **Expected**: calibration never promotes you *to* 6 and never runs
   *at* 6. The only way in is typing it.

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

## Scenario 14 — `repair` recovers a state dir a bug left broken

**Goal**: the two-profile state is detected, announced on every turn,
and fixed without ever eating a real profile.

This is the only scenario that reproduces a defect on purpose, because
this state is the one thing a user cannot recognise on their own: from
inside a session it looks exactly like a healthy plugin sitting at a
level they never chose.

1. Note your real level, then pause:
   ```
   /socratiskill:socratic status
   /socratiskill:socratic pause
   ```
2. Simulate the damage the pre-v0.5.3 Stop hook did — a profile rebuilt
   from nothing, which is what made the axis fall back to its default:
   ```bash
   printf '%s' '{"last_active":"2020-01-01T00:00:00.000Z","last_user_message_length":19}' \
     > ~/.claude/socratic/profile.json
   ```
3. Send any normal prompt.
   **Expected**: the context reports `level: 3` — a level nobody chose —
   *and* carries a `STATE INCONSISTENT` line saying so and naming
   `repair`. Without that line the wrong level would look authoritative,
   which is the whole failure mode.
4. ```
   /socratiskill:socratic resume
   ```
   **Expected**: it REFUSES (`cannot resume: both ... exist`) and points
   at `repair`. Refusing is correct — with two profiles present it cannot
   know which one you want.
5. ```
   /socratiskill:socratic repair
   ```
   **Expected**, and check all four:
   - a `running: v...` line with the version and path of the code
     actually executing. On a plugin install the path ends in the
     version number, so a stale install is visible here.
   - `the damage was done at: 2020-01-01...` — dated BEFORE any update,
     i.e. leftover state rather than a live bug.
   - it names your real level, read from `.paused`, not the fake 3.
   - **nothing on disk changed.** Both files are still there:
     ```bash
     ls ~/.claude/socratic/profile.json*
     ```
6. ```
   /socratiskill:socratic repair --apply
   ```
   **Expected**: the auto-generated profile is discarded, `.paused` is
   restored, and the next prompt reports your original level with no
   `STATE INCONSISTENT` line. Run `repair` once more: `[ok] state is
   consistent`.

**The half that matters more** — `repair` must never delete a profile
someone actually configured. With a healthy calibrated profile in place,
`/socratiskill:socratic repair --apply` must report `nothing to repair`
and leave the file untouched. Same for a profile created by
`init-profile.sh` and never calibrated: it carries session bookkeeping
too, and only its remaining fields tell it apart from the artifact.

---

## If something fails

File an issue with: (1) scenario + step, (2) expected vs. observed,
(3) contents of the relevant files (`profile.json`, the latest
session file, `antipatterns.json`), (4) versions of Claude Code and
bun.
