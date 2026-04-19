```
    ███████╗ ██████╗  ██████╗██████╗  █████╗ ████████╗██╗███████╗██╗  ██╗██╗██╗     ██╗
    ██╔════╝██╔═══██╗██╔════╝██╔══██╗██╔══██╗╚══██╔══╝██║██╔════╝██║ ██╔╝██║██║     ██║
    ███████╗██║   ██║██║     ██████╔╝███████║   ██║   ██║███████╗█████╔╝ ██║██║     ██║
    ╚════██║██║   ██║██║     ██╔══██╗██╔══██║   ██║   ██║╚════██║██╔═██╗ ██║██║     ██║
    ███████║╚██████╔╝╚██████╗██║  ██║██║  ██║   ██║   ██║███████║██║  ██╗██║███████╗███████╗
    ╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝
    ──────────────────────────────────────────────────────────────────────────────────────
    ░▒▓█   A D A P T I V E   S O C R A T I C   M E N T O R   F O R   C L A U D E   █▓▒░
                       >>  v0.1 · MIT · github.com/VicBa2000/socratiskill  <<
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

## Install (local dev)

```bash
git clone https://github.com/VicBa2000/socratiskill ~/socratiskill
cd ~/socratiskill
bash scripts/install.sh
```

What it does:
1. Verifies `bun` + `node` are available.
2. Creates `~/.claude/socratic/profile.json` with defaults (level 3,
   learn mode, enabled=true).
3. Registers the `UserPromptSubmit` + `Stop` hooks in
   `~/.claude/settings.json`, pointing to the plugin's scripts
   (idempotent — re-running is a no-op).

Then, inside a Claude Code session:

```
/plugin marketplace add ~/socratiskill
/plugin install socratiskill@socratiskill
/reload-plugins
/socratiskill:socratic calibrate
```

Calibration asks a single self-assessment question (1-5) and sets
your pedagogical level accordingly.

---

## Subcommands

Invoke as `/socratiskill:socratic <arg>`.

| Subcommand | Effect |
|---|---|
| `status` (or no args) | Snapshot: enabled, level, mode, speed, copy, streak, calibrated |
| `on` / `off` | Toggle the enabled flag (hooks stop injecting without touching settings.json) |
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

---

## How it works

### Deterministic channels (no fork of Claude Code)

1. **`UserPromptSubmit` hook** -> runs `scripts/build-context.ts`,
   which reads `profile.json` + detectors (zero-knowledge, copy-paste,
   slow-down, domain taxonomy) + error-map (Leitner due) + antipattern
   state + feynman state from the session file. Emits a
   `SOCRATIC CONTEXT` block to stdout. Claude Code injects it into the
   model context as a `system-reminder`.
2. **`Stop` hook** -> runs `scripts/record-turn.ts`, which parses the
   transcript, extracts the HINT_META (emitted as an HTML comment,
   invisible to the user), and updates the session file + error-map +
   antipattern state + continuous calibration.
3. **Skills** -> `/socratiskill:socratic` (user-invoked) is the
   control panel; `/socratiskill:socratic-ping` is a health probe.

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
- **Session files are per-UTC-day**, not per-Claude-Code-session. If
  you open 2 parallel sessions on the same day, both write to the
  same file (no locking — theoretical race condition, not observed).
- **HINT_META as HTML comment** assumes the markdown renderer strips
  comments. Works in the Claude Code TUI; if it shows up visible in
  another client, open an issue.

---

## Disable / uninstall

**Temporary toggle** (keeps state and hooks):
```
/socratiskill:socratic off
```
To re-enable: `/socratiskill:socratic on`.

**Full uninstall** (removes hooks from settings.json, asks about the
history):
```bash
bash scripts/uninstall.sh
# flags: --keep-state, --purge, --dry-run
```

Then, inside Claude Code: `/plugin uninstall socratiskill`.

---

## Testing

Run the full synthetic test suite (18 scenarios, 42+ assertions):

```bash
bash tests/run-all.sh
# flags: --only <N>, --stop-on-fail, --list
```

For a manual end-to-end in a live Claude Code session, see
[MANUAL-TEST.md](./MANUAL-TEST.md).

---

## Architecture

```
.claude-plugin/        plugin.json + marketplace.json
skills/
  socratic/            user-invoked control panel (/socratiskill:socratic)
  socratic-ping/       health probe (/socratiskill:socratic-ping)
  socratic-mentor/     model-invoked soft reinforcement
scripts/
  hook-pre-prompt.sh   UserPromptSubmit hook -> build-context.ts
  hook-post-turn.sh    Stop hook -> record-turn.ts
  build-context.ts     emits the SOCRATIC CONTEXT block per turn
  record-turn.ts       parses HINT_META, updates session/error-map/antipatterns
  detector.ts          heuristics: zero-knowledge, copy-paste, slow-down
  taxonomy.ts          domain classification (7 buckets)
  hint-state.ts        Leitner box state machine
  start-teach.ts / end-teach.ts / pick-review.ts / build-journal.ts
  install.sh / uninstall.sh
data/                  domains, prerequisites, technical terms, antipatterns,
                       roles, algorithm constants
tests/run-all.sh       18 scenarios, 42 assertions
```

For the full per-turn flow, see [MANUAL-TEST.md](./MANUAL-TEST.md).

---

## License

MIT. See [LICENSE](./LICENSE).
