```
    ███████╗ ██████╗  ██████╗██████╗  █████╗ ████████╗██╗███████╗██╗  ██╗██╗██╗     ██╗
    ██╔════╝██╔═══██╗██╔════╝██╔══██╗██╔══██╗╚══██╔══╝██║██╔════╝██║ ██╔╝██║██║     ██║
    ███████╗██║   ██║██║     ██████╔╝███████║   ██║   ██║███████╗█████╔╝ ██║██║     ██║
    ╚════██║██║   ██║██║     ██╔══██╗██╔══██║   ██║   ██║╚════██║██╔═██╗ ██║██║     ██║
    ███████║╚██████╔╝╚██████╗██║  ██║██║  ██║   ██║   ██║███████║██║  ██╗██║███████╗███████╗
    ╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝
    ──────────────────────────────────────────────────────────────────────────────────────
    ░▒▓█   A D A P T I V E   S O C R A T I C   M E N T O R   F O R   C L A U D E   █▓▒░
                       >>  v0.2 · MIT · github.com/VicBa2000/socratiskill  <<
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
```

> **Where do the files land?** The command above **always** drops the
> repo at your **home folder**, in a new `socratiskill/` subfolder,
> regardless of what directory your terminal is currently `cd`'d into.
> On Windows that is `C:\Users\<you>\socratiskill`, on macOS
> `/Users/<you>/socratiskill`, on Linux `/home/<you>/socratiskill`.
> Running the command from `Desktop/`, `Documents/`, `Pictures/`, etc.
> does **not** change this — `git clone` obeys the destination in the
> command, not your current location. This is normal, not malware. If
> you want the repo elsewhere, change the destination (e.g. `git clone
> <url> ~/Desktop/socratiskill`); whatever path you pick, remember it
> — Step 2 needs it verbatim.

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
when the path given does not contain `.claude-plugin/marketplace.json`
(e.g. because `~` was taken literally, or the directory is empty).
Retry with a correct absolute path.

That is the whole setup. The plugin manifest (`hooks/hooks.json`)
auto-registers the `UserPromptSubmit` and `Stop` hooks via Claude
Code's plugin system, so the hooks fire in **every** project — no
per-project setup, no editing of `~/.claude/settings.json`. Calibration
asks one self-assessment question (1-5) and writes
`~/.claude/socratic/profile.json` with your pedagogical level.

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
| `pause` / `resume` | **True bypass.** Renames `profile.json` ↔ `profile.json.paused` so the hook short-circuits before producing any output. **Zero token cost per turn**, vs ~30 for `off`. Use when you want the plugin truly invisible without uninstalling. |
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
   model context as a `system-reminder`. At level 1, the block also
   includes a `LEVEL 1 HARD LIMITS` reinforcement (max 30 lines per
   turn, max 1 file, mandatory restate→plan→teach→verify protocol).
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

**4. Full uninstall** — removes hook entries from `~/.claude/settings.json`
(only relevant if you used the legacy install path), asks about the
state directory:
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
bash tests/run-all.sh         # 21 scenarios, 61 assertions (functional)
bash tests/run-security.sh    #  8 scenarios, 40 assertions (adversarial)
# flags for both: --only <N>, --stop-on-fail, --list
```

**`run-all.sh`** exercises every script and state transition in
isolated temp dirs: calibration (per-level up/down thresholds,
weighted scoring by hint level, topic-diversity floor, and the
3-turn diagnostic gate the agent must pass before a level-up is
actually proposed), hint escalation, antipatterns, Feynman mode,
Leitner spaced repetition, journal generation, install/uninstall
idempotence, the level-1 hard-limits block injection, the
pause/resume cycle, and the `enabled=false` silencer.

**`run-security.sh`** runs adversarial tests against the audit guards:
hostile `STATE_DIR` values to `uninstall.sh` (path traversal, root,
`$HOME`, outside `$HOME`), corrupt session JSON recovery, atomic
write under interruption, concurrent RMW on `profile.json`,
antipattern regex bounds, hostile stdin to the hooks, and topic
injection (null bytes, RTL unicode, shell metacharacters).

Combined: **101 assertions, all green** as of v0.2.

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
  run-all.sh           21 scenarios, 61 assertions (functional)
  run-security.sh      8 scenarios, 40 assertions (adversarial)
```

For the full per-turn flow, see [MANUAL-TEST.md](./MANUAL-TEST.md).

---

## License

MIT. See [LICENSE](./LICENSE).
