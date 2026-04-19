---
name: socratic
description: Adaptive socratic mentor entry point. Invoked as /socratiskill:socratic to view the current pedagogical profile, change level/mode, or inspect which rules are active. For automatic per-turn injection, the plugin's UserPromptSubmit hook handles it outside this skill.
argument-hint: "[status | on | off | calibrate | level <1-5> | mode <learn|productive> | hint | faster | slower | challenge | accept | teach <topic> | endteach | review | journal [today|week|month]]"
allowed-tools: [Read, Write, Bash]
---

# Socratic (mentor entry point)

This skill is the control panel for the **socratiskill** plugin. It does
not run the socratic logic by itself — that is injected on every turn
via the `UserPromptSubmit` hook. Here the user can inspect and mutate
the persistent profile.

Persistent state lives at: `~/.claude/socratic/profile.json`.

## Path convention (`<plugin-root>`)

Several subcommands below invoke scripts as `bun run <plugin-root>/scripts/<name>.ts`
or `bash <plugin-root>/scripts/<name>.sh`. When executing these commands,
`<plugin-root>` resolves to the directory **two levels above this
SKILL.md file**. Concretely:

- This file lives at `<plugin-root>/skills/socratic/SKILL.md`.
- So `<plugin-root>/scripts/foo.ts` is `../../scripts/foo.ts` relative
  to this file.

When using Bash to invoke a script, resolve the absolute path by
climbing two directories up from this SKILL.md and appending
`scripts/<name>`.

## Subcommands

The user invokes `/socratiskill:socratic $ARGUMENTS`. Dispatch by the
first word:

- **no arguments** or `status` -> Respond with a profile snapshot:
  ```
  enabled: <true|false>
  level:   <global_level> (<role for the level>)
  mode:    <learn|productive>
  speed:   <comprehension_speed>
  copy:    <copy_tendency>
  streak:  <streak_days> days
  calibrated: <true|false>
  ```
  If `enabled` is `false`, append: `(hooks installed but skill inactive
  — run /socratiskill:socratic on to re-enable)`.

- `on` -> Activate the skill: write `enabled: true` to profile.json.
  Starting next turn, the UserPromptSubmit hook will inject SOCRATIC
  CONTEXT and the Stop hook will record telemetry again. Respond:
  ```
  socratiskill: enabled
  SOCRATIC CONTEXT will inject on next turn.
  ```

- `off` -> Deactivate the skill: write `enabled: false` to profile.json.
  Hooks remain installed but exit immediately (no injection, no
  recording). Instant toggle; does NOT require `/reload-plugins` or
  touching settings.json. Respond:
  ```
  socratiskill: disabled
  run /socratiskill:socratic on to re-enable.
  ```

- `level <1-5>` -> Update `global_level` in `~/.claude/socratic/profile.json`.
  Validate range. Respond:
  ```
  level updated: <old> -> <new> (<role>)
  ```
  If out of range (1-5), respond `invalid level: <N>` and write nothing.

- `mode <learn|productive>` -> Update `mode` in profile.json. Validate
  that it is one of the two values. Respond:
  ```
  mode updated: <old> -> <new>
  ```

- `calibrate` -> Run the initial calibration flow (self-assessment,
  1 question). See "Calibration flow" below.

- `hint` / `faster` -> Raise hint level +1 (more direct). Run
  `bun run <plugin-root>/scripts/adjust-hint.ts --delta +1` and show
  stdout. Both subcommands are mechanical aliases; `hint` is the
  user's shortcut when they need more help, `faster` is for when they
  want you to be more direct.

- `slower` -> Lower hint level -2 (more socratic). Run
  `bun run <plugin-root>/scripts/adjust-hint.ts --delta -2`.

- `challenge` -> Activate anti-adulation mode for 1 turn. Read
  profile.json, add `challenge_next_turn: true`, rewrite with Write.
  The UserPromptSubmit hook consumes it on the next turn and injects
  the note. Respond:
  ```
  challenge mode armed: will apply to your next message
  ```

- `accept` -> Apply the last suggested calibration (raise or lower
  global_level according to pending_calibration_change). Run
  `bun run <plugin-root>/scripts/accept-calibration.ts` and show stdout.
  If no pending change exists, the script exits 2; show stderr verbatim.

- `teach <topic>` -> Activate Feynman mode (role inversion: the user
  teaches the topic, the model probes and detects gaps). Run
  `bun run <plugin-root>/scripts/start-teach.ts --topic "<topic>"` and
  show stdout. If a teach session is already active, the script exits 2
  and stderr instructs the user to run `endteach` first.

- `endteach` -> Close Feynman mode, print a summary of detected gaps,
  and leave `feynman_summaries[]` in the session file (the journal
  harvests it). Run `bun run <plugin-root>/scripts/end-teach.ts` and
  show stdout. If no teach session is active, exit 2 with stderr.

- `review` -> Execute a spaced-repetition card. Run
  `bun run <plugin-root>/scripts/pick-review.ts`. If the first stdout
  line starts with "no review cards due", respond with that exact
  message and stop. If a card is present, follow the protocol in
  `rules/review.md`: pose ONE verifiable question about the topic,
  wait for the user's response on the next turn, and close with
  HINT_META using the EXACT topic slug returned by pick-review (so the
  Leitner scheduler updates the correct card).

- `journal [today|week|month]` -> Regenerate the journal for the
  requested period (default: today) from the session files, and print
  it. Run `bun run <plugin-root>/scripts/build-journal.ts --period <p>`
  and show stdout verbatim. The script also writes
  `~/.claude/socratic/journal/<file>.md` for later reference.

For anything else, respond:
```
unknown subcommand: <args>
valid: status | on | off | calibrate | level <1-5> | mode <learn|productive> | hint | faster | slower | challenge | accept | teach <topic> | endteach | review | journal [today|week|month]
```

## Role reference (see rules/)

Role names are loaded from `data/roles.json` and kept consistent across
all consumers (this SKILL, `build-context.ts`, `accept-calibration.ts`):

- Level 1 (Novice) -> Live teacher. See `rules/level-1-teacher.md`.
- Level 2 (Basic) -> Teacher with context. See `rules/level-2-guide.md`.
- Level 3 (Intermediate) -> Pair programmer. See `rules/level-3-pair.md`.
- Level 4 (Advanced) -> Code reviewer. See `rules/level-4-reviewer.md`.
- Level 5 (Expert) -> Silent colleague. See `rules/level-5-silent.md`.

Mode rules are in `rules/mode-learn.md` and `rules/mode-productive.md`.

## Execution instructions

1. Parse `$ARGUMENTS`. With no arguments, treat as `status`.
2. Read `~/.claude/socratic/profile.json` with Read.
3. For `status`, format and respond. For the `role` field per level,
   use the table:
   - 1 -> Live teacher
   - 2 -> Teacher with context
   - 3 -> Pair programmer
   - 4 -> Code reviewer
   - 5 -> Silent colleague
4. For `level N` or `mode X`, validate and rewrite the full JSON with
   the updated field (preserve all other fields). Use Write with the
   complete JSON.
5. Do not add extra text or emojis. Keep the response minimal and
   exactly in the specified format.
6. For `hint`, `faster`, `slower`: invoke the script via Bash using
   `bun run <plugin-root>/scripts/adjust-hint.ts --delta <±N>` and
   show its stdout/stderr. The script clamps to [0,5] and creates
   today's session file if missing.
7. For `challenge`: read profile.json with Read, add the field
   `challenge_next_turn: true`, rewrite with Write preserving the
   other fields. Do not delegate to any script.
8. For `accept`: invoke `bun run <plugin-root>/scripts/accept-calibration.ts`
   via Bash. If the script exits 2 (no pending change), show its stderr
   verbatim.
9. For `teach <topic>`: invoke `bun run <plugin-root>/scripts/start-teach.ts
   --topic "<topic>"` via Bash. Quote the topic with double quotes to
   handle spaces. Show stdout verbatim. On exit 2, show stderr verbatim
   and do not add any extra text.
10. For `endteach`: invoke `bun run <plugin-root>/scripts/end-teach.ts`
    via Bash. Show stdout verbatim. On exit 2 (no active teach), show
    stderr.
11. For `review`: invoke `bun run <plugin-root>/scripts/pick-review.ts`
    via Bash. Read the first stdout line:
    - If it is "no review cards due": respond with that line to the
      user and close with HINT_META topic=null, correct=null.
    - If it is "review card found ...": extract topic/domain/fails/
      overdue_by/last_hint_level from the key:value pairs, pose ONE
      verifiable (closed, not open-ended) question, present it to the
      user, and close with HINT_META: topic=<exact slug from the
      card>, correct=null, domain=<card domain>. Do not write the
      answer in this turn. See `rules/review.md` for the full two-turn
      protocol.
12. For `journal [today|week|month]`: default is `today` if no second
    word is given. Invoke `bun run <plugin-root>/scripts/build-journal.ts
    --period <p>` via Bash and show stdout verbatim. If the user passes
    anything other than today|week|month, the script exits 2 — show
    stderr and add no text of your own.
13. For `on` / `off`: read profile.json with Read, set `enabled: true`
    (on) or `enabled: false` (off), rewrite with Write preserving all
    other fields. Respond with the exact block from the subcommand
    section. Do not invoke any external script — this is a simple
    JSON mutation.
14. For `status`: in addition to the standard snapshot, read the
    `enabled` field. If absent or true, the first line is
    `enabled: true`. If false, print `enabled: false` and append the
    notice after the status lines: `(hooks installed but skill
    inactive — run /socratiskill:socratic on to re-enable)`.

## Calibration flow

When `$ARGUMENTS == "calibrate"`:

1. Read `~/.claude/socratic/profile.json`. If `calibration_completed
   == true`, respond:
   ```
   already calibrated: level <N> (<role>)
   to recalibrate, delete profile.json or run: /socratiskill:socratic calibrate force
   ```
   If the argument is exactly `calibrate force`, proceed as if it were
   not calibrated (the flow continues).

2. Present EXACTLY this message to the user (do not modify and do not
   add extra emojis — the only one allowed is the one in the text):

   ```
   Welcome to Socratiskill 🎓

   To adapt my pedagogical style, I need to know your programming
   experience level. Pick the option that best describes you:

     1. Novice       — Starting out. I need detailed explanations.
     2. Basic        — I know fundamentals but need frequent guidance.
     3. Intermediate — I code regularly. I solve problems with some help.
     4. Advanced     — Solid experience. I prefer code review and challenges.
     5. Expert       — Fluent in multiple technologies. Silent colleague, that's it.

   Respond with the number (1-5) or the level name.
   ```

3. Wait for the user's response. Parse using these rules (lowercase
   after trimming):
   - Direct number 1-5 -> that level.
   - Keyword (substring match, bilingual for backward compatibility):
     * "novice" | "beginner" | "novato" | "noob" | "principiante"  -> 1
     * "basic" | "basico"                                           -> 2
     * "intermediate" | "intermedio"                                -> 3
     * "advanced" | "avanzado"                                      -> 4
     * "expert" | "pro" | "experto"                                 -> 5
   - If no rule matches, respond:
     ```
     did not understand. respond with a number from 1 to 5
     or one of these words: novice, basic, intermediate, advanced, expert.
     ```
     And wait again.

4. Once the level N is parsed, run commit-calibration.sh via Bash:
   ```
   bash <plugin-root>/scripts/commit-calibration.sh --level N
   ```
   (Remember `<plugin-root>` resolves to two directories up from this
   SKILL.md — see the "Path convention" section at the top.)

5. If the script exits 0, respond:
   ```
   calibration complete: level N (<role>)
   mode defaults to: learn
   run /socratiskill:socratic mode productive if you prefer speed over depth.
   ```
   On error, show stderr and stop without touching anything else.
