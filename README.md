```
    ███████╗ ██████╗  ██████╗██████╗  █████╗ ████████╗██╗███████╗██╗  ██╗██╗██╗     ██╗
    ██╔════╝██╔═══██╗██╔════╝██╔══██╗██╔══██╗╚══██╔══╝██║██╔════╝██║ ██╔╝██║██║     ██║
    ███████╗██║   ██║██║     ██████╔╝███████║   ██║   ██║███████╗█████╔╝ ██║██║     ██║
    ╚════██║██║   ██║██║     ██╔══██╗██╔══██║   ██║   ██║╚════██║██╔═██╗ ██║██║     ██║
    ███████║╚██████╔╝╚██████╗██║  ██║██║  ██║   ██║   ██║███████║██║  ██╗██║███████╗███████╗
    ╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝
    ──────────────────────────────────────────────────────────────────────────────────────
    ░▒▓█   A D A P T I V E   S O C R A T I C   M E N T O R   F O R   C L A U D E   █▓▒░
                       >>  v0.5.2 · MIT · github.com/VicBa2000/socratiskill  <<
```

# Socratiskill

Plugin for [Claude Code](https://claude.com/claude-code) that turns it
into an **adaptive socratic mentor**: adjusts pedagogical level,
escalates hints, detects weaknesses with spaced repetition, forces
Feynman mode, flags antipatterns, and produces a learning journal —
all without forking the binary.

Since v0.5 there is **one dial**. The level, 1 to 5, answers a single
question — *how much of the work is yours?* — and everything else follows
from the answer: what Claude may author, how much it explains, and what
it hands you to write. At level 3 it writes skeletons and signatures and
every function body is yours; at level 5 it writes nothing at all and
just asks. A `PreToolUse` gate enforces it, so above level 1 this is not
a request Claude can talk itself out of.

That inverts the usual reward: **levelling up means Claude does less for
you, not more.** For a plugin whose purpose is fighting the skill atrophy
that comes from directing agents all day, any other direction would be
training the disease.

The pedagogical layer is a port of [SocraticCode](../opencode) (an
OpenCode fork). Rather than patching the agent loop, this version
ships as a Claude Code plugin and lives entirely in hooks + markdown
instructions + TypeScript scripts.

---

## Requirements

- **Claude Code** with plugin + hooks support (`UserPromptSubmit`,
  `Stop`, and `PreToolUse` for the authorship gate).
- **[bun](https://bun.com)** (runtime for the telemetry scripts).
- **node** (used only by bootstrap scripts to manipulate JSON without
  depending on `jq`, which is not available in Git Bash on Windows).
- Git Bash on Windows / bash on macOS / Linux.

---

## Install

Two paths. Almost everyone wants path A.

### Path A — from GitHub (recommended)

You do **not** clone anything. Inside a Claude Code session:

```
/plugin marketplace add VicBa2000/socratiskill
/plugin install socratiskill@socratiskill
/reload-plugins
/socratiskill:socratic calibrate
```

Claude Code fetches the plugin into
`~/.claude/plugins/marketplaces/socratiskill/` and manages it from
there. To get future releases:

```
/plugin update socratiskill@socratiskill
```

That does a `git pull` of the marketplace and re-installs. One command,
no terminal gymnastics.

### Path B — from a local clone (dev / offline mode)

Use this only if you want to edit the plugin source. Updates are
manual (`git pull` + `/plugin update`).

```bash
git clone https://github.com/VicBa2000/socratiskill ~/socratiskill
```

> **Where do the files land?** The command above **always** drops the
> repo at your **home folder**, in a new `socratiskill/` subfolder,
> regardless of what directory your terminal is currently `cd`'d into.
> On Windows that is `C:\Users\<you>\socratiskill`, on macOS
> `/Users/<you>/socratiskill`, on Linux `/home/<you>/socratiskill`.
> Running the command from `Desktop/`, `Documents/`, `Pictures/`, etc.
> does **not** change this — `git clone` obeys the destination in the
> command, not your current location. This is normal, not malware.

Then, inside a Claude Code session, register the marketplace **with an
absolute path** (the `/plugin` CLI does not reliably expand `~` on
Windows):

```
/plugin marketplace add C:/Users/<you>/socratiskill        # Windows
/plugin marketplace add /Users/<you>/socratiskill          # macOS
/plugin marketplace add /home/<you>/socratiskill           # Linux
/plugin install socratiskill@socratiskill
/reload-plugins
/socratiskill:socratic calibrate
```

Forward slashes work on Windows. **Verify the marketplace was actually
registered** by checking that your entry is in the file:

```bash
cat ~/.claude/plugins/known_marketplaces.json
```

If `socratiskill` is **not** listed, the `marketplace add` silently
failed — Claude Code can still print "Successfully added marketplace"
when the path given does not contain `.claude-plugin/marketplace.json`.
Retry with a correct absolute path.

To update a path-B install, first pull manually:

```bash
cd ~/socratiskill && git pull
```

then, inside Claude Code: `/plugin update socratiskill@socratiskill`.
The `/plugin update` button alone does nothing for path B because
Claude Code treats your local clone as a plain directory, not a git
repo.

### What both paths produce

The plugin manifest (`hooks/hooks.json`) auto-registers the
`UserPromptSubmit`, `Stop` and `PreToolUse` hooks via Claude Code's
plugin system, so
the hooks fire in **every** project — no per-project setup, no editing
of `~/.claude/settings.json`. Calibration asks one self-assessment
question (1-5) and writes `~/.claude/socratic/profile.json` with your
pedagogical level.

### Optional: legacy install path

If you prefer not to use the plugin system (for example you want
the hooks installed directly into `~/.claude/settings.json`), run:

```bash
bash ~/socratiskill/scripts/install.sh
```

This verifies `bun` + `node`, seeds `profile.json` with defaults, and
writes the hook entries to `~/.claude/settings.json` (idempotent).

> **This path registers `UserPromptSubmit` and `Stop` only — not
> `PreToolUse`, which is the gate.** Without it the axis still *tells*
> Claude what it may author, but nothing *enforces* it: levels 2-5
> degrade to advice, and they degrade silently, because a level that is
> merely suggested looks exactly like one that is enforced until the
> moment Claude writes something it should not have. Prefer the plugin
> install above, which registers all three from `hooks/hooks.json`.
Use this **only** if you are not installing as a plugin — otherwise
you would register the hooks twice and they would fire 2× per turn.

---

## Subcommands

Invoke as `/socratiskill:socratic <arg>`.

| Subcommand | Effect |
|---|---|
| `status` (or no args) | The whole control panel: the axis (level, what you may author, budget left, rung range), any episode in flight, and today's autonomy numbers |
| `on` / `off` | Soft toggle of the `enabled` flag. When `off`, the hook still fires but injects only a short DISABLED silencer (~30 tokens) telling the model to behave as default Claude Code. |
| `pause` / `resume` | **True bypass.** Renames `profile.json` ↔ `profile.json.paused` so the hook short-circuits before producing any output. Emits a one-shot silencer on the very first turn after pause (tells the model to forget skill instructions loaded earlier in the session), then **zero token cost per turn** until resume. Use when you want the plugin truly invisible without uninstalling. |
| `calibrate` | Self-assessment + level update. `calibrate force` to recalibrate. |
| `level <1-5>` | Set the axis. This is the only pedagogical setting there is. |
| `ship [minutes] <reason>` | Open a logged escape: Claude writes normally until it expires (default 10 min), then the level re-arms itself. A reason is required — it is the whole accountability mechanism. Never questioned or moralized about. The minutes go **first**: a trailing number is read as part of the reason, since in `ship fix issue 3` the 3 belongs to the reason. |
| `drill analyze [<file>]` | Get quizzed on code that already exists in your repo. The script picks the file on rotation, not the model. Works at any level — reading was never the restricted half. |
| `drill build` | Implement a bounded task from a blank page. Needs level 3+; below that Claude writes the bodies and the drill measures nothing. Reports lines you wrote on `drill done`. |
| `drill fix [<file>]` | Make a surgical change to code that already exists. Needs level 3+. Two phases: Claude states one change request, then you must work out **where** it goes before touching anything — that is the exercise. Reports whether you located it first try. |
| `drill status\|done\|cancel` | Inspect, close, or abandon the running drill |
| `hint` / `faster` | Raise hint level by 1 (more direct) |
| `slower` | Lower hint level by 2 (more socratic) |
| `challenge` | Anti-adulation mode for 1 turn (no flattery, harder answers) |
| `accept` | Apply the last automatic calibration suggestion |
| `teach <topic>` | Activate Feynman mode (role inversion — you teach, Claude probes gaps) |
| `endteach` | Close Feynman mode and print a gap summary |
| `template [on\|off]` | "Pasame la plantilla, yo codifico." Claude hands over structure — real signature, numbered work order in comments, an anchor in your own repo, one flagged trap left open — and stops; you write the bodies. **Levels 1-3 only:** at L1 it overrides the level (which otherwise says Claude writes the code); at L2-L3 it only sets the shape of the skeletons those levels already hand over; at L4+ it is not injected at all, because there you already write everything and a template directive could only loosen your level. A delivery mode, not a level change: it does not move `global_level` and it does not relax the gate. |
| `review` | Run one due Leitner card (spaced repetition) |
| `journal [today\|week\|month]` | Generate a markdown rollup in `~/.claude/socratic/journal/` |
| `reset` / `reset force` | Wipe all local socratic state (profile, journal, error-map, sessions, antipatterns). Bare `reset` prints a confirmation prompt; `reset force` invokes `uninstall.sh --purge` with its hardened path guards. Plugin itself stays installed — complete removal still needs `/plugin uninstall socratiskill`. |

### Choosing between `off`, `pause`, and `disable`

| State | Token cost / turn | Hook executes | State preserved | How to revert |
|---|---|---|---|---|
| Default | full SOCRATIC CONTEXT (~200-400) | yes | yes | — |
| `off` | ~30 (silencer) | yes | yes | `/socratiskill:socratic on` |
| `pause` | **0** | yes but exits in ~5ms | yes (in `.paused`) | `/socratiskill:socratic resume` |
| `/plugin disable` | 0 | no | yes | `/plugin enable` |
| `/plugin uninstall` | 0 | no | only with `--keep-state` | reinstall + recalibrate |

`pause` fills the gap between `off` (soft) and `disable` (heavy) — the
sweet spot for "I want zero token cost without touching the plugin
manifest".

---

## How it works

### Deterministic channels (no fork of Claude Code)

1. **`UserPromptSubmit` hook** -> runs `scripts/build-context.ts`,
   which reads `profile.json` + detectors (zero-knowledge, copy-paste,
   slow-down, domain taxonomy) + error-map (Leitner due) + antipattern
   state + feynman state from the session file. Emits a
   `SOCRATIC CONTEXT` block to stdout. Claude Code injects it into the
   model context as a `system-reminder`. The block also includes a
   **per-level protocol reinforcement** calibrated to the current
   level and mode (see "Per-level protocols" below).
2. **`Stop` hook** -> runs `scripts/record-turn.ts`, which parses the
   transcript, extracts the HINT_META (emitted as an HTML comment,
   invisible to the user), and updates the session file + error-map +
   antipattern state + continuous calibration.
3. **Hook registration** -> declared in `hooks/hooks.json` and
   auto-registered when the plugin is installed via `/plugin install`.
   No editing of `~/.claude/settings.json` required. The hooks fire in
   every project regardless of project-local `.claude/settings.json`.
4. **Skills** -> `/socratiskill:socratic` (user-invoked) is the
   control panel; `/socratiskill:socratic-ping` is a health probe.

### The axis — one dial

Through v0.4 there were three pedagogical axes (level 1-5, mode
learn/productive, immersive on/off) plus two escape valves. They were
not really independent: **in all ten level × mode combinations, Claude
wrote the code.** The level only varied how much it explained. The axis
measured pedagogical overhead, never authorship — so "you type this one"
had nowhere to live and had to be bolted on as a separate mode, which
then needed its own valve, its own window and its own report.

v0.5 collapses all of it into one number:

| Level | Claude authors | You write | Rungs | Hands you |
|---|---|---|---|---|
| **1** Implementer | the implementation | nothing — you read and get questioned | 5 | — |
| **2** Framer | structure + trivial bodies | the load-bearing logic | 4-5 | a module |
| **3** Architect | skeletons and signatures | **every function body** | 3-4 | a unit |
| **4** Guide | nothing | all of it | 2-3 | a subproblem |
| **5** Socratic | nothing | all of it, undirected | 0-1 | — |

```
/socratiskill:socratic level 3
```

The contract lives in `data/levels.json` and nothing may contradict it.
What used to be separate switches is now just a position on this line:
old immersive mode is levels 4-5, the old scaffold window is what levels
2-3 do by default, and `mode: productive` merged into `ship`.

#### What the gate enforces

Above level 1 this is not a request Claude can talk itself out of. A
`PreToolUse` hook denies `Write`/`Edit`/`MultiEdit`/`NotebookEdit` on
files that already exist, refuses delegation to a subagent, and inspects
`Bash` to block `>` redirects, `tee`, `sed -i`, `git apply` and friends.
Running your tests, git, builds and linters stays allowed — that is the
point.

Three layers, in the order they fire:

1. **Create vs edit.** Whether a file already exists is a *fact*.
   "Is this boilerplate or the code that teaches you?" is a *judgment*,
   and a judgment handed to the model is one its helpfulness gradient
   widens until the exception swallows the feature. So the gate only
   ever checks the fact.
2. **Shape.** A file Claude creates must *look like a skeleton*. Rather
   than trying to detect an implementation — open-ended, and a model can
   out-invent any blacklist — the gate asserts the closed property:
   every line is classified, and anything it does not recognise counts as
   an executable statement. Unknown syntax and unlisted languages fail
   **closed** by construction. At levels 3-5 the allowance is zero:
   imports, types, signatures, comments and `TODO`s, nothing that runs.
   Failing closed is only *usable* if the recogniser speaks the language
   in front of it, so it carries explicit vocabulary for TypeScript/JS,
   Python, C#, Java, SQL, Go, Rust, Kotlin, Swift, C/C++, Ruby and PHP.
   The loose rules a language needs are gated by file extension — SQL's
   column rule cannot judge TypeScript — and the extension comes from
   the *path*, never the content, so the model cannot pick its own
   ruleset by writing a shebang. New files are also capped at 80 lines
   regardless of level.
3. **Budget.** A daily cap on new files, so a fooled gate is bounded.

The plugin's own state stays writable throughout, so `off`, `pause`,
`level` and `challenge` can never be locked behind the gate.

#### The ladder — the dial *inside* your level

Same state machine as always: escalates after two failed answers, jumps
to the top when you say "no sé", drops on a success. Each rung means
something different now that "more help" can no longer mean "more code":
0 asks only, 2 points you at code you already wrote elsewhere in the
repo, 5 hands over a full **work order** — files, signatures, acceptance
criteria, edge cases — and still never code.

Level and rung are deliberately *not* the same dial. The level is your
stable band and moves by calibration over days; the rung is the reaction
inside one problem and moves over minutes. Collapsing them would mean
getting stuck on a single bug demotes you.

#### The handoff (levels 2-4)

    frame → name the unit → acceptance criteria → STOP → evaluate → next

Claude delivers the structure its level allows, names **one** unit, and
states acceptance criteria *before any code exists* — which is what makes
the later review objective instead of a matter of taste. Then it stops.
When you come back it reviews against those criteria, and only then moves
on.

A unit that fails gets **handed back, not fixed**. It is the most
valuable turn in the loop: the only moment you find your own gap while
it is still warm.

#### The escape

```
/socratiskill:socratic ship "prod hotfix" 20
```

Claude writes normally until it expires, then the level re-arms itself.
A reason is required and logged; it is never questioned or moralized
about. A lock with no exit is a lock you uninstall the first Friday it
gets in the way — and flattery and scolding are the same error of not
respecting your decision.

#### Autonomy report

`status` prints, per day and per repository:

```
autonomy — 2026-09-01 (level 3)
you wrote: +127 / -34 lines in /home/you/project
created by the agent: +18 lines across 2 file(s) (excluded from the count above)
turns where you produced code: 6 / 11
average ladder rung: 2.3 (lower = you needed less help)
escapes: 1 (5 min total) — prod hotfix
note: code the agent wrote during an escape is included in the line count above.
```

The line count comes from git, not from Claude's self-report: with the
gate armed, what appears in the working tree came from your hands. It
survives mid-session commits (which move `HEAD` and reset the
working-tree diff) and counts files you have not `git add`ed yet —
starting something new means creating files, and `git diff HEAD` alone
would report all of that as zero.

Baselines are kept **per repository** and roll over daily, so changing
projects mid-day measures the new project instead of quietly reporting on
the one you left.

Two deliberate asymmetries in how honest the number is:

- Lines Claude wrote by **creating a file** are subtracted exactly — the
  gate saw every one of them.
- Lines it wrote during an **escape** cannot be told apart from yours in
  the same working tree, so the report *says so* rather than implying a
  clean number.

Totals per period land in `journal` under `## Autonomy`. There is no
score and no goal: the signal is the trend across two journals, and a
composite index would be a number this plugin invented.

#### Drills

```
/socratiskill:socratic drill analyze     # can you still read your project?
/socratiskill:socratic drill build       # can you still start from zero?
```

`analyze` picks a source file from your repo **on rotation, in the
script** — asked to choose, a model reliably picks something short and
convenient, and you cannot steer it either. It then asks one question
per turn, escalating from "what does this do" to "what breaks if I
remove this". Wrong answers become Leitner cards and come back
scheduled. It works at any level; reading was never the restricted half.

`build` needs level 3 or higher, proposes one bounded task from your
repo, and fixes acceptance criteria **before** any code exists — which
is what makes the closing review objective rather than a matter of
taste.

`fix` targets the gap the other two leave. `analyze` trains reading and
`build` trains authoring from zero; neither trains **locating** — being
handed unfamiliar code and a change request and working out where the
change belongs. That is the shape of most real requests (*"esta página
da error, chécala y agregale tokens de sesión"*), and the first thing to
go when an agent does all the navigating.

It runs in two phases. Claude reads a file from the rotation, states one
concrete change request, and then asks *where* it goes — without naming
the function or quoting the line. Only once your answer holds up does it
advance to implementation. `drill done` reports whether you located it
first try, flat, because that is the number that says whether the
navigation muscle is still there.

It never plants a defect in your repo. It works on the code as it is and
finds a genuine gap by reading; mutating your working tree to manufacture
an exercise is not a trade this makes.

### Per-level protocols

Soft sentences in markdown drift against the system prompt's pull toward
"be helpful, complete tasks", so an imperative protocol block is injected
at the end of every `SOCRATIC CONTEXT`, right before the model generates.
It is chosen by **level and nothing else** — there is no mode to cross it
with, because "who writes the code" *is* the level.

| Level | Canonical behavior |
|-------|--------------------|
| **1** Implementer | Restate → plan → teach → ONE comprehension question. END turn. MAX 30 lines / 1 file per turn. No Write/Edit without explicit approval in THIS turn. Every line still has to teach, or this is level 6 with extra words. |
| **2** Framer | Frame the module; leave every load-bearing body empty with a `TODO`. Hand over one module with acceptance criteria, then stop. Trivial bodies allowed (8 statements/file). |
| **3** Architect | Skeletons and signatures only — **zero** executable statements per file. Decompose into ordered units, hand over one, state criteria, stop. Never solve the first "to show the pattern". |
| **4** Guide | Write nothing. Point at an analogous case already solved in *their* repo (Read/Grep are yours). Decompose; hand over the first subproblem. |
| **5** Socratic | Write nothing, direct nothing. Questions only, orientation at most after two failures. Do not decompose — that is a level-4 move and the most common leak. |
| **6** Autopilot | The axis off. Plain code assistant, no pedagogy, no commentary about being here. |

Level 6 is reachable only by typing it: calibration clamps at 5 and can
never promote there. It is deliberately absent from the subcommand table
above — an anti-atrophy plugin that advertises its own off switch is
working against itself — but `status` always names it, because
discouraging discovery is not the same as hiding state from someone who
already turned it on.

### Calibration and anti-adulation gates

Level-up is gated by a pipeline designed to prevent optimistic /
sycophantic promotion:

- **Per-level thresholds** (from `data/algorithm.json`): L1 needs
  10 correct in a window of 12; L2 7/9; L3 and L4 each 5/7. Down
  is uniform 3/5.
- **Weighted scoring**: each correct answer is weighted
  `(5 - hintLevel) / 5`, adjusted ±0.25 by the model's `readiness`
  self-report. The average must be ≥ **0.5** — equivalent to hints
  no heavier than analogy-level. "10 correct answers with full
  scaffolding" is obedience, not dominion; it is blocked.
- **Topic diversity floor**: at least `ceil(needed/2)` distinct
  topics in the window. 10 correct answers on the same topic do
  not count as readiness.
- **Depth diversity floor**: at least `ceil(needed/2)` of the
  correct answers must have been answered with `hintLevel ≤ 2`.
  This blocks the case where the model always gives heavy hints
  because it perceives the user as a novice.
- **Diagnostic gate**: if all of the above pass, the system does
  NOT promote directly. It enters a 3-turn diagnostic quiz where
  the model inserts comprehension questions targeted at the
  next level, masked as natural follow-ups. The user must pass
  at least 2/3. During the diagnostic, an explicit
  **ANTI-ADULATION** instruction is injected that tells the
  grader to treat vague / partial / hand-wavy answers as FAIL and
  to default to FAIL on ambiguity.
- **Down-leveling bypasses the diagnostic** — being stuck above
  your level is worse than a false downgrade.

Only after the diagnostic passes does `pending_calibration_change`
appear, and the system nudges the user to run
`/socratiskill:socratic accept`. **The system never changes the
level on its own.**

For the full technical reference of every system (rules, thresholds,
state files, hook contents), see [sistemas.txt](./sistemas.txt).

### Robustness invariants

- **Atomic writes** for every state JSON via `tmp + renameSync` —
  a process killed mid-write leaves the previous file intact, never a
  half-written one.
- **`O_EXCL` lock** on `profile.json` read-modify-write so concurrent
  Claude Code sessions never lose updates. Cross-platform (no `flock`
  dependency on Git Bash for Windows).
- **Schema validators** post-`JSON.parse` reject corrupted or
  schema-shifted state and fall back to defaults instead of
  propagating undefined fields.
- **Corrupt session recovery**: if `sessions/<date>.json` is malformed,
  start-teach backs it up to `<path>.corrupt-<epoch>` and starts
  fresh; end-teach backs up and aborts so no turns are lost.
- **`uninstall.sh` path guard**: refuses any `STATE_DIR` that is not
  absolute, not under `$HOME`, lacks the `.claude/socratic` segment,
  or contains a `..` traversal. Both POSIX and Windows-native
  absolute paths are accepted.

### Persistent state

Everything under `~/.claude/socratic/`:

```
profile.json                  pedagogical profile (level, mode, enabled, etc.)
error-map.json                Leitner box + next_review_at per topic
antipatterns.json             occurrence_count + active flag per antipattern
sessions/<YYYY-MM-DD>.json    per-turn telemetry (topic, correct, hint_level, feynman, gaps)
journal/                      daily/weekly/monthly markdown rollups
```

---

## Honest limitations

- **Authorship is enforced; pedagogy is not.** Above level 1 the
  `PreToolUse` gate actually denies tool calls. Everything else — how
  much Claude explains, the antipatterns, the handoff protocol — is
  injected as text and depends on the model obeying it (observed
  consistently with Opus 4.7, but not guaranteed).
- **The gate blocks tools, not text.** It cannot stop Claude from
  pasting code into the chat for you to copy. The rules forbid it and
  nothing enforces it — if that happens, the level has failed and only
  you will notice.
- **A new file can still hide an implementation.** The shape check makes
  this expensive rather than impossible: unknown syntax counts as an
  executable statement and the write is denied, but the check is
  line-based and no substitute for reading the diff. The daily budget
  bounds the damage; the ledger keeps the *measurement* honest even when
  the gate is fooled, since those lines are attributed to Claude anyway.
- **Nothing stops you opening a second Claude Code window** without the
  plugin. This is voluntary training; route around it and there is no
  one to fool but yourself. The plugin does not police this and will not
  ask about it.
- **The autonomy line count is repo-wide.** It measures what changed in
  the working tree, which during a `ship` escape includes code Claude
  wrote. The report discloses this rather than implying a clean number.
- **The axis says nothing about code quality.** Writing bad code
  unassisted still trains the muscle. Reviews are honest, but the goal
  is production, not perfection.
- **Initial calibration is a self-assessment**, not diagnostic. A
  version with 5 scoreable technical questions is future work.
- **Session files are per-UTC-day**, not per-Claude-Code-session. Two
  parallel sessions on the same day share the same file, but writes
  are atomic (`renameSync`) and `profile.json` read-modify-write is
  serialized with an `O_EXCL` lock, so you will not lose data.
- **HINT_META as HTML comment** assumes the markdown renderer strips
  comments. Works in the Claude Code TUI; if it shows up visible in
  another client, open an issue.

### Privacy

All socratic state is stored locally under `~/.claude/socratic/`. The
hook stdout that is injected into the model context on every turn
contains your current level, mode, detected signals, active
antipatterns, and the titles of review-due topics. If you pipe hook
output to a shared log or run Claude Code with verbose logging, that
information is exposed there — review your log destinations before
sharing them. Turn records (`sessions/<date>.json`) store 200-char
excerpts of your prompt and the model reply; avoid pasting secrets
(API keys, proprietary code) into prompts if you are uncomfortable
with that residue.

---

## Disable / pause / uninstall

Four levels of "stop the plugin", from softest to heaviest:

**1. Soft toggle** — keeps state, hook still runs but injects only a
short DISABLED silencer (~30 tokens):
```
/socratiskill:socratic off       # disable
/socratiskill:socratic on        # re-enable
```

**2. True bypass** — keeps state, hook short-circuits to zero output
(zero token cost):
```
/socratiskill:socratic pause     # rename profile.json → .paused
/socratiskill:socratic resume    # rename back
```
Equivalent shell scripts: `bash scripts/pause.sh` / `bash scripts/resume.sh`.

**3. Plugin-level disable** (Claude Code feature, hooks stop registering):
```
/plugin disable socratiskill
/plugin enable socratiskill
```

> **Why the model still emits `HINT_META` or `restate/plan/verify`
> preambles right after you pause/disable/uninstall.** When the plugin
> was active, its SKILL.md and META PROTOCOL instructions were injected
> into the model's context as system-reminders. Those instructions live
> in the conversation's **context window** and cannot be retroactively
> removed — LLMs have no "forget that earlier message" operation.
> Pause/disable/uninstall stop the hook from injecting NEW context, but
> they do not un-teach what the model already absorbed in this session.
> To fully silence: **restart Claude Code** (close the CLI and relaunch).
> A fresh session starts with no socratic context loaded. The one-shot
> silencer emitted by `pause` (added in v0.2) also helps, telling the
> model to "ignore prior pedagogical instructions" — but context reset
> via restart is the only guarantee.
>
> Separately, the `※ recap:` self-summary lines you may see are a
> Claude Code / model behavior, not a socratiskill feature — `grep
> recap` on this repo returns zero matches. They appear in any Claude
> Code session and are unrelated to the plugin.

**4. Full uninstall** — two equivalent paths:

From inside Claude Code (preferred, no need to know paths):
```
/socratiskill:socratic reset force       # wipes state
/plugin uninstall socratiskill            # removes plugin
/plugin marketplace remove socratiskill
```

Or from the shell (same guards):
```bash
bash scripts/uninstall.sh
# flags: --keep-state, --purge, --dry-run
```

Then, inside Claude Code: `/plugin uninstall socratiskill`.

---

## Testing

Two complementary suites — together cover the pedagogical flow AND the
threat model.

```bash
bash tests/run-all.sh         # 39 scenarios, 308 assertions (functional)
bash tests/run-security.sh    #  8 scenarios, 40 assertions (adversarial)
# flags for both: --only <N>, --stop-on-fail, --list
```

**`run-all.sh`** exercises every script and state transition in
isolated temp dirs: calibration (per-level up/down thresholds,
weighted scoring by hint level, topic-diversity floor, depth-
diversity floor, the 3-turn diagnostic gate, and the anti-
adulation injection during the diagnostic), hint escalation,
per-level protocol blocks for all six levels, antipatterns, Feynman
mode, Leitner spaced repetition, journal generation,
install/uninstall idempotence, the pause/resume cycle, the
`enabled=false` silencer, and the whole axis: the gate (create-vs-edit,
the shape check in both directions — honest skeletons in all thirteen
supported languages must pass, real implementations must not, and the
line-level contract pins each construct so a widened regex cannot
quietly swallow a statement), the daily budget, subagent delegation,
bash write-detection with a false-positive battery), the `ship` escape and
its expiry, the v0.4→v0.5 profile migration, the handoff protocol and
unit continuity across turns, the git-based autonomy measurement across
a mid-session commit and across two repositories, drill selection and
rotation, the control-plane exemption that keeps the gate from locking
you out of its own off switch, and the documentation contract — the
help text is checked against the code it describes, so a subcommand
list that drifts from the dispatcher, or a phrase describing a feature
that was removed, fails the suite instead of reaching a user.

**`run-security.sh`** runs adversarial tests against the audit guards:
hostile `STATE_DIR` values to `uninstall.sh` (path traversal, root,
`$HOME`, outside `$HOME`), corrupt session JSON recovery, atomic
write under interruption, concurrent RMW on `profile.json`,
antipattern regex bounds, hostile stdin to the hooks, and topic
injection (null bytes, RTL unicode, shell metacharacters).

Combined: **323 assertions, all green** as of v0.5.2.

For a manual end-to-end in a live Claude Code session, see
[MANUAL-TEST.md](./MANUAL-TEST.md).

---

## Architecture

```
.claude-plugin/        plugin.json + marketplace.json
hooks/
  hooks.json           plugin manifest hook declarations (auto-registered)
skills/
  socratic/            user-invoked control panel (/socratiskill:socratic)
    rules/             level 1-6, axis, ladder, handoff, feynman, review,
                       antipatterns, drills
  socratic-ping/       health probe (/socratiskill:socratic-ping)
  socratic-mentor/     model-invoked soft reinforcement
scripts/
  hook-pre-prompt.sh   UserPromptSubmit hook -> build-context.ts
  hook-post-turn.sh    Stop hook -> record-turn.ts
  hook-pre-tool.sh     PreToolUse hook -> gate-tool.ts. Short-circuits in
                       bash builtins on levels 1 and 6, so the tool call
                       it cannot block costs as little as possible
  build-context.ts     emits the SOCRATIC CONTEXT block per turn
  record-turn.ts       parses HINT_META, updates session/error-map/antipatterns
  gate-tool.ts         the authorship gate: create-vs-edit, shape, budget,
                       subagent delegation, bash used as an editor
  axis-state.ts        pure contract: levels, rungs, budget, escape
  shape-check.ts       "is this a skeleton?" — fails closed by design
  status.ts            the single control panel
  escape.ts            `ship` — the logged escape hatch
  autonomy-report.ts   git-based measurement, per repo, per day
  migrate-profile.ts   v0.4.x -> v0.5 schema migration
  drill.ts             analyze / build drill selection and state
  state-io.ts          atomic writes, O_EXCL locks, schema-validated reads
  detector.ts          heuristics: zero-knowledge, copy-paste, slow-down
  taxonomy.ts          domain classification (7 buckets)
  hint-state.ts        Leitner box state machine
  antipatterns.ts      regex-based code-smell detector (with ReDoS guards)
  start-teach.ts / end-teach.ts / pick-review.ts / build-journal.ts
  pause.sh / resume.sh true-bypass toggle (vs the soft `off` silencer)
  install.sh / install-hooks.sh / uninstall.sh   legacy install path
data/                  domains, prerequisites, technical terms, antipatterns,
                       roles, algorithm constants
tests/
  run-all.sh           39 scenarios, 308 assertions (functional)
  run-security.sh      8 scenarios, 40 assertions (adversarial)
sistemas.txt           full technical reference (rules, thresholds,
                       state files, hooks, every system)
```

For the full per-turn flow, see [MANUAL-TEST.md](./MANUAL-TEST.md).
For the full technical reference, see [sistemas.txt](./sistemas.txt).

---

## License

MIT. See [LICENSE](./LICENSE).
