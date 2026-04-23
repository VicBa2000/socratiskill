```
    ███████╗ ██████╗  ██████╗██████╗  █████╗ ████████╗██╗███████╗██╗  ██╗██╗██╗     ██╗
    ██╔════╝██╔═══██╗██╔════╝██╔══██╗██╔══██╗╚══██╔══╝██║██╔════╝██║ ██╔╝██║██║     ██║
    ███████╗██║   ██║██║     ██████╔╝███████║   ██║   ██║███████╗█████╔╝ ██║██║     ██║
    ╚════██║██║   ██║██║     ██╔══██╗██╔══██║   ██║   ██║╚════██║██╔═██╗ ██║██║     ██║
    ███████║╚██████╔╝╚██████╗██║  ██║██║  ██║   ██║   ██║███████║██║  ██╗██║███████╗███████╗
    ╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝
    ──────────────────────────────────────────────────────────────────────────────────────
    ░▒▓█   A D A P T I V E   S O C R A T I C   M E N T O R   F O R   C L A U D E   █▓▒░
                       >>  v0.3 · MIT · github.com/VicBa2000/socratiskill  <<
```

# Socratiskill

Plugin for [Claude Code](https://claude.com/claude-code) that turns it
into an **adaptive socratic mentor**: adjusts pedagogical level,
escalates hints, detects weaknesses with spaced repetition, forces
Feynman mode, flags antipatterns, and produces a learning journal —
all without forking the binary.

The pedagogical layer is a port of [SocraticCode](../opencode) (an
OpenCode fork). Rather than patching the agent loop, this version
ships as a Claude Code plugin and lives entirely in hooks + markdown
instructions + TypeScript scripts.

---

## Requirements

- **Claude Code** with plugin + hooks support (`UserPromptSubmit`,
  `Stop`).
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
`UserPromptSubmit` and `Stop` hooks via Claude Code's plugin system, so
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
Use this **only** if you are not installing as a plugin — otherwise
you would register the hooks twice and they would fire 2× per turn.

---

## Subcommands

Invoke as `/socratiskill:socratic <arg>`.

| Subcommand | Effect |
|---|---|
| `status` (or no args) | Snapshot: enabled, level, mode, speed, copy, streak, calibrated |
| `on` / `off` | Soft toggle of the `enabled` flag. When `off`, the hook still fires but injects only a short DISABLED silencer (~30 tokens) telling the model to behave as default Claude Code. |
| `pause` / `resume` | **True bypass.** Renames `profile.json` ↔ `profile.json.paused` so the hook short-circuits before producing any output. Emits a one-shot silencer on the very first turn after pause (tells the model to forget skill instructions loaded earlier in the session), then **zero token cost per turn** until resume. Use when you want the plugin truly invisible without uninstalling. |
| `calibrate` | Self-assessment + level update. `calibrate force` to recalibrate. |
| `level <1-5>` | Manually set global_level |
| `mode <learn\|productive>` | Change pedagogical mode |
| `hint` / `faster` | Raise hint level by 1 (more direct) |
| `slower` | Lower hint level by 2 (more socratic) |
| `challenge` | Anti-adulation mode for 1 turn (no flattery, harder answers) |
| `accept` | Apply the last automatic calibration suggestion |
| `teach <topic>` | Activate Feynman mode (role inversion — you teach, Claude probes gaps) |
| `endteach` | Close Feynman mode and print a gap summary |
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

### Per-level protocols

Each user level has a **canonical behavior** that the model should
exhibit reliably, independently of the soft markdown rules. Since
soft sentences can drift against the system prompt's pull toward
"be helpful, complete tasks", an imperative protocol block is
injected at the end of every `SOCRATIC CONTEXT` block for L1-L4,
calibrated to the level's role and attenuated by `mode`. L5 (silent
colleague) gets no injection — it is the default Claude Code
behavior.

| Level | Role                  | Initial hint | Canonical behavior (learn) |
|-------|-----------------------|--------------|----------------------------|
| L1    | Live teacher          | 5            | Restate → plan → teach → ONE comprehension question. END turn. MAX 30 lines / 1 file per turn. No Write/Edit without explicit approval in THIS turn. |
| L2    | Teacher with context  | 4            | Before non-trivial decisions, state the WHY in 1-2 sentences. After each new block, ONE comprehension question. Block-by-block, never line-by-line. |
| L3    | Pair programmer       | 2            | "What approach do you have in mind?" before non-trivial implementations. Gapped code (`___`) in at least one spot per turn. Gaps raised as questions, not corrections. |
| L4    | Code reviewer         | 1            | Before accepting a proposal, raise at least ONE challenge as a question: edge case, security, scalability, or alternative. No explanations of basics. |
| L5    | Silent colleague      | 0            | Pure code assistant. Intervenes only for vulnerabilities, serious bugs, anti-patterns, or significantly better alternatives. |

In `productive` mode, the L2-L4 blocks are attenuated: L2 drops to
one WHY sentence per non-obvious decision; L3 skips the approach
preamble and gapped code; L4 flags only critical issues as brief
questions.

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

- **Soft enforcement.** Claude Code does not expose a hook over
  `Write`/`Edit`, so the skill **cannot block** tool calls. Antipatterns
  and pedagogical rules are applied via instructions in the hook
  stdout and depend on the model obeying them (observed consistently
  with Opus 4.7, but not guaranteed).
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
bash tests/run-all.sh         # 23 scenarios, 90 assertions (functional)
bash tests/run-security.sh    #  8 scenarios, 40 assertions (adversarial)
# flags for both: --only <N>, --stop-on-fail, --list
```

**`run-all.sh`** exercises every script and state transition in
isolated temp dirs: calibration (per-level up/down thresholds,
weighted scoring by hint level, topic-diversity floor, depth-
diversity floor, the 3-turn diagnostic gate, and the anti-
adulation injection during the diagnostic), hint escalation,
per-level protocol blocks for L1-L4 across both `learn` and
`productive` modes, antipatterns, Feynman mode, Leitner spaced
repetition, journal generation, install/uninstall idempotence,
the pause/resume cycle, and the `enabled=false` silencer.

**`run-security.sh`** runs adversarial tests against the audit guards:
hostile `STATE_DIR` values to `uninstall.sh` (path traversal, root,
`$HOME`, outside `$HOME`), corrupt session JSON recovery, atomic
write under interruption, concurrent RMW on `profile.json`,
antipattern regex bounds, hostile stdin to the hooks, and topic
injection (null bytes, RTL unicode, shell metacharacters).

Combined: **130 assertions, all green** as of v0.3.

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
  socratic-ping/       health probe (/socratiskill:socratic-ping)
  socratic-mentor/     model-invoked soft reinforcement
scripts/
  hook-pre-prompt.sh   UserPromptSubmit hook -> build-context.ts
  hook-post-turn.sh    Stop hook -> record-turn.ts
  build-context.ts     emits the SOCRATIC CONTEXT block per turn
  record-turn.ts       parses HINT_META, updates session/error-map/antipatterns
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
  run-all.sh           23 scenarios, 90 assertions (functional)
  run-security.sh      8 scenarios, 40 assertions (adversarial)
sistemas.txt           full technical reference (rules, thresholds,
                       state files, hooks, every system)
```

For the full per-turn flow, see [MANUAL-TEST.md](./MANUAL-TEST.md).
For the full technical reference, see [sistemas.txt](./sistemas.txt).

---

## License

MIT. See [LICENSE](./LICENSE).
