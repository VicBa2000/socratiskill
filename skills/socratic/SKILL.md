---
name: socratic
description: Adaptive socratic mentor entry point. Invoked as /socratiskill:socratic to view the current level on the pedagogical axis, change it, or inspect which rules are active. For automatic per-turn injection, the plugin's UserPromptSubmit hook handles it outside this skill.
argument-hint: "[status | on | off | pause | resume | calibrate | level <1-5> | ship [minutes] <reason> | drill [analyze <file>|build|fix <file>|status|done|cancel] | hint | faster | slower | challenge | accept | teach <topic> | endteach | template [on|off] | review | journal [today|week|month] | reset [force]]"
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

- **no arguments** or `status` -> Run
  `bun run <plugin-root>/scripts/status.ts` and show stdout **verbatim**.
  Do NOT reformat it, do not summarize it, and do not add commentary to
  the autonomy numbers — no congratulation, no softening of a low count,
  no goals. An honest number the user can act on is the product.
  Exit 3 = no profile; show stderr verbatim.

- `on` -> Activate the skill: write `enabled: true` to profile.json.
  Starting next turn, the UserPromptSubmit hook will inject SOCRATIC
  CONTEXT and the Stop hook will record telemetry again. Respond:
  ```
  socratiskill: enabled
  SOCRATIC CONTEXT will inject on next turn.
  ```

- `off` -> Deactivate the skill: write `enabled: false` to profile.json.
  Hooks remain installed but inject only a short DISABLED silencer
  (~30 tokens) telling the model to behave as default Claude Code.
  Instant toggle; does NOT require `/reload-plugins` or touching
  settings.json. Respond:
  ```
  socratiskill: disabled
  run /socratiskill:socratic on to re-enable.
  ```

- `pause` -> True bypass — renames `profile.json` to `profile.json.paused`
  so the hook short-circuits before generating ANY output. Zero token
  cost per turn (vs ~30 tokens for `off`). Use when you want the plugin
  truly invisible for a stretch of work without losing your level /
  streak / error-map. Run `bash <plugin-root>/scripts/pause.sh` and
  show stdout verbatim.

- `resume` -> Reverse of `pause` — renames `profile.json.paused` back to
  `profile.json` so hooks resume injecting SOCRATIC CONTEXT on the next
  turn. Run `bash <plugin-root>/scripts/resume.sh` and show stdout
  verbatim. Both `pause` and `resume` are idempotent: invoking them
  twice in a row is a no-op the second time.

- `level <1-5>` -> Update `global_level` in `~/.claude/socratic/profile.json`.
  Respond:
  ```
  level updated: <old> -> <new> (<role>)
  ```
  Accept 1, 2, 3, 4 and 5. Also accept 6 if the user types it, without
  offering it and without commenting on the choice. For anything else,
  respond `invalid level: <N>` listing `1-5`, and write nothing.

- `ship [minutes] <reason>` -> Open a logged escape: the agent writes
  normally until it expires, then the level re-arms by itself. Defaults
  to 10 minutes; `ship 25 "demo del viernes"` sets it explicitly.
  A reason is REQUIRED — it is the whole accountability mechanism.
  Run `bun run <plugin-root>/scripts/escape.ts [minutes] <reason>`
  (or `--status` / `--end`) and show stdout verbatim. The minutes go
  FIRST: a trailing number is read as part of the reason, so
  `escape.ts "fix prod" 25` silently means 10 minutes. Prefer the
  explicit `--minutes N --reason "<why>"` form when you are the one
  building the command.
  **Do not editorialize when the user ships.** No "are you sure", no
  reminder about their goals, no disappointment. Real work has real
  deadlines, and a lock with no exit gets the plugin uninstalled. The
  log is the accountability, not your commentary.
  Exit 2 = no reason given, or nothing to escape from (level 1 and
  level 6 already let the agent write); exit 3 = no profile.

- `drill [analyze [<file>] | build | fix [<file>] | status | done | cancel]` ->
  Deliberate practice drawn from the user's own repo.
  - `drill analyze [<file>]` — the user is quizzed on existing code.
    Works at any level: reading was never the restricted half. With no
    path, the script picks the file on rotation; **do not override that
    choice** and do not suggest a different file.
  - `drill build` — the user implements a bounded task from scratch.
    Requires level 3 or higher; below that the agent writes the bodies
    and the drill measures nothing. The script exits 2 with
    instructions.
  - `drill fix [<file>]` — the user makes a surgical change to code
    that already exists. Requires level 3+. TWO PHASES: state one
    concrete change request, then make them work out WHERE it goes
    before any code. Do NOT name the function or quote the line — that
    is the exercise. When their answer holds up, run
    `drill.ts --advance` (add `--miss` if it took more than one try).
    **NEVER edit their files to plant a defect**: work on the code as
    it is and find a genuine gap by reading.
  - `drill status` / `drill done` / `drill cancel` — inspect, close (a
    build or fix drill reports lines written), or abandon.
  Run `bun run <plugin-root>/scripts/drill.ts` with `--kind analyze
  [--file <path>]`, `--kind build`, `--kind fix [--file <path>]`,
  `--advance [--miss]`, `--status`, `--done`, or `--cancel`.
  Show stdout verbatim, then follow the protocol in `rules/drills.md`.
  Exit 2 = another drill is running, file not found, nothing drillable
  found, or the level is too low; show stderr verbatim.

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

- `template [on|off]` -> Turn the template delivery mode on or off for
  today's session. "Pasame la plantilla, yo codifico": the agent hands
  over structure — real signature, numbered work order in comments, an
  anchor in the user's own repo, one flagged trap — and stops; the user
  writes the bodies. Run `bun run <plugin-root>/scripts/template.ts <on|off>`
  and show stdout. Exit 2 = already in that state (stderr says so).

  It is a DELIVERY mode, not a level: it never touches `global_level`,
  and it never loosens the contract — the only direction it can move it is
  tighter. At level 1 it ARMS the gate (see below). Its reason for existing is level 1,
  where the level says the agent writes and a user who would rather type
  the bodies had to ask for it again every single turn — and, because
  level 1 does not arm the gate, `user_wrote` was never even recorded.

  **It applies at levels 1-3 only.** At L1 it overrides the level; at
  L2-L3 it only sets the shape of the skeletons those levels already
  deliver; at L4 and above the hook does not inject it at all, because
  the user already writes everything there and the directive could only
  loosen the level — "hand over structure" read at level 5 would turn it
  into a level 3. Running `template on` above level 3 reports that it
  changes nothing. See `rules/template.md`.

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

- `reset` -> Wipe ALL local socratic state (profile, journal,
  error-map, sessions, antipatterns). Destructive — requires confirmation
  unless `reset force` is passed. Run
  `bash <plugin-root>/scripts/uninstall.sh --purge` (the script has
  hardened path-traversal guards — refuses any STATE_DIR not under
  `$HOME/.claude/socratic/`). After the state is gone, print:
  ```
  [ok] state wiped: ~/.claude/socratic/

  the plugin itself is still installed. to fully remove it:
    /plugin uninstall socratiskill
    /plugin marketplace remove socratiskill
  to keep using the plugin, run /socratiskill:socratic calibrate
  again to create a fresh profile.
  ```
  If the user passes bare `reset` (no force), ask once:
  ```
  this will DELETE your entire socratic state (profile, journal,
  error-map, sessions, antipatterns) at ~/.claude/socratic/.
  this cannot be undone.
  
  to proceed, run: /socratiskill:socratic reset force
  ```
  and do NOT invoke the script.

For anything else, respond:
```
unknown subcommand: <args>
valid: status | on | off | pause | resume | calibrate | level <1-5> | ship [minutes] <reason> | drill [analyze <file>|build|fix <file>|status|done|cancel] | hint | faster | slower | challenge | accept | teach <topic> | endteach | template [on|off] | review | journal [today|week|month] | reset [force]
```

## The axis (see rules/)

There is ONE pedagogical setting: the level. It answers one question —
**how much of the work is the user's?** — and everything else follows.
The contract lives in `data/levels.json` and is frozen in
`unificacion.txt` §12.B. If a rules file contradicts that table, the
table wins.

- Level 1 -> Implementer. The agent implements; the user is questioned.
  See `rules/level-1-implementer.md`.
- Level 2 -> Framer. Structure and trivial bodies; the user writes the
  load-bearing logic. See `rules/level-2-framer.md`.
- Level 3 -> Architect. Skeletons and signatures; every body is the
  user's. See `rules/level-3-architect.md`.
- Level 4 -> Guide. Writes nothing; decomposes and points at prior art.
  See `rules/level-4-guide.md`.
- Level 5 -> Socratic. Writes nothing, directs nothing. Asks.
  See `rules/level-5-socratic.md`.

Shared rules: `rules/axis.md` (the role), `rules/ladder.md` (the rungs),
`rules/handoff.md` (giving the user a unit and evaluating what returns).

## Execution instructions

1. Parse `$ARGUMENTS`. With no arguments, treat as `status`.
2. Read `~/.claude/socratic/profile.json` with Read.
3. For `status`, run `scripts/status.ts` and relay its stdout verbatim.
   Do not rebuild the snapshot yourself — one renderer, one format.
4. For `level N`, validate and rewrite the full JSON with the updated
   field (preserve all other fields). Use Write with the complete JSON.
   Role names for the response come from `data/levels.json`.
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
14. For `ship`: everything after the word `ship` is the reason, UNLESS
    the first token is a bare number — then it is the minute count and
    the rest is the reason. Pass the reason double-quoted. With no
    reason, do not invoke anything: respond
    `ship needs a reason, e.g. /socratiskill:socratic ship prod hotfix`.
    Show the script's stdout verbatim and add NO commentary of your own,
    in either direction.
15. For `drill`: parse the SECOND word. `analyze` -> `--kind analyze`,
    plus `--file "<third word>"` if a path was given. `build` ->
    `--kind build`. `fix` -> `--kind fix`, plus `--file "<third word>"`
    if a path was given. `status`/`done`/`cancel` -> the matching flag.
    No second word -> `--status`. Anything else: respond
    `unknown: drill <word>` and invoke nothing.
    `--advance` is yours to call mid-drill, not a user subcommand.
    After a successful start, read the target file with Read before your
    first question — you cannot grade an answer about code you have not
    read.
16. For `status`: the script owns the whole snapshot, including the
    disabled and paused notices. Relay it verbatim and add nothing.

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

   The level decides HOW MUCH OF THE WORK IS YOURS — not how much I
   explain. Higher means you write more of it, and I do less.

     1. Implementer — I write the code and question you as I go.
     2. Framer      — I frame the structure and the trivial parts;
                      you write the logic that actually decides things.
     3. Architect   — I write skeletons and signatures; every body is
                      yours.
     4. Guide       — I write nothing. I break the problem down and
                      point you at what you already solved.
     5. Socratic    — I write nothing and direct nothing. I ask.

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
   the level is the only dial: higher means more of the work is yours.
   run /socratiskill:socratic level <1-5> to change it at any time.
   ```
   On error, show stderr and stop without touching anything else.
