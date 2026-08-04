/**
 * immersive.ts — CLI for the immersive operating mode.
 *
 * Used by the /socratiskill:socratic subcommands `immersive on|<N>|off|status`.
 * Pure state logic lives in immersive-state.ts; this file owns the I/O.
 *
 * CLI: bun run immersive.ts --on [--minutes N]
 *      bun run immersive.ts --off
 *      bun run immersive.ts --status
 *
 * The profile is mutated under a lock because record-turn.ts and
 * build-context.ts write the same file on every turn.
 */

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { HintState } from "./hint-state"
import { Immersive } from "./immersive-state"
import { ImmersiveReport } from "./immersive-report"
import { StateIO } from "./state-io"
import ALGORITHM_JSON from "../data/algorithm.json"

interface Args {
  on?: boolean
  off?: boolean
  status?: boolean
  unlock?: boolean
  scaffold?: boolean
  scaffoldStatus?: boolean
  scaffoldClose?: boolean
  files?: number
  minutes?: number
  reason?: string
}

const ALGO = ALGORITHM_JSON as {
  scaffold_files_by_level?: Record<string, number>
  scaffold_max_lines_per_file?: number
  scaffold_window_minutes?: number
}
const SCAFFOLD_FILES_BY_LEVEL: Record<string, number> =
  ALGO.scaffold_files_by_level ?? { "1": 2, "2": 3, "3": 5, "4": 8, "5": 12 }
const SCAFFOLD_MAX_LINES: number = ALGO.scaffold_max_lines_per_file ?? 80
const SCAFFOLD_MINUTES: number = ALGO.scaffold_window_minutes ?? 20

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    if (a === "--on") out.on = true
    else if (a === "--off") out.off = true
    else if (a === "--status") out.status = true
    else if (a === "--unlock") out.unlock = true
    else if (a === "--scaffold") out.scaffold = true
    else if (a === "--scaffold-status") out.scaffoldStatus = true
    else if (a === "--scaffold-close") out.scaffoldClose = true
    else if (a === "--files" && v !== undefined) {
      out.files = Number(v)
      i++
    } else if (a === "--minutes" && v !== undefined) {
      out.minutes = Number(v)
      i++
    } else if (a === "--reason" && v !== undefined) {
      out.reason = v
      i++
    }
  }
  return out
}

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return fallback
  }
}

/**
 * Hint rung at activation, for the autonomy report. Prefer today's live
 * rung; fall back to the level's starting rung when no session exists yet.
 */
function currentHint(level: number): number {
  const sess = readJson<{ hint_state?: HintState.State }>(
    join(stateDir(), "sessions", `${todayIso()}.json`),
    {},
  )
  if (sess.hint_state && typeof sess.hint_state.currentLevel === "number") {
    return HintState.clampHint(sess.hint_state.currentLevel)
  }
  return HintState.getInitialHintLevel(HintState.clampUserLevel(level))
}

function profilePath(): string {
  return join(stateDir(), "profile.json")
}

function requireProfile(): Record<string, unknown> {
  const p = profilePath()
  if (!existsSync(p)) {
    if (existsSync(`${p}.paused`)) {
      process.stderr.write(
        "error: socratiskill is paused. run /socratiskill:socratic resume first.\n",
      )
      process.exit(3)
    }
    process.stderr.write(
      "error: no profile found. run /socratiskill:socratic calibrate first.\n",
    )
    process.exit(3)
  }
  return readJson<Record<string, unknown>>(p, {})
}

function readState(profile: Record<string, unknown>): Immersive.State | null {
  const raw = profile["immersive"]
  return Immersive.isState(raw) ? raw : null
}

function mutate(fn: (profile: Record<string, unknown>) => void): void {
  const p = profilePath()
  StateIO.withLock(`${p}.lock`, () => {
    const fresh = readJson<Record<string, unknown>>(p, {})
    fn(fresh)
    StateIO.writeJsonAtomic(p, fresh)
  })
}

function cmdOn(args: Args): void {
  const profile = requireProfile()
  const now = new Date()
  const existing = readState(profile)

  if (Immersive.isActive(existing, now)) {
    const left = Immersive.remainingMinutes(existing!, now)
    process.stdout.write(
      `immersive already active${left === null ? " (no timebox)" : ` (${left} min left)`}\n`,
    )
    return
  }

  let minutes: number | null = null
  if (args.minutes !== undefined) {
    if (!Number.isFinite(args.minutes) || args.minutes <= 0) {
      process.stderr.write("error: --minutes must be a positive number\n")
      process.exit(2)
    }
    minutes = Math.round(args.minutes)
  }

  const level = Math.min(5, Math.max(1, Number(profile["global_level"]) || 3))
  const state = Immersive.create(now, minutes, currentHint(level))
  // Snapshot git now so the report can tell what the user wrote later.
  // Best-effort: outside a repo this is null and the summary degrades to
  // the soft signals.
  state.git_baseline = ImmersiveReport.captureBaseline(process.cwd())
  mutate((p) => {
    p["immersive"] = state
  })

  process.stdout.write(
    `immersive: ON${minutes === null ? " (no timebox — run 'immersive off' to end)" : ` for ${minutes} min`}\n` +
      "the agent will NOT write code. it coaches; you type.\n" +
      "stuck? answer its questions — it escalates help automatically.\n" +
      "real deadline? /socratiskill:socratic unlock <reason>\n",
  )
}

/**
 * Today's session turns, for the soft signals in the report. An immersive
 * session that spans midnight only sees the turns filed under today; the
 * git measurement is unaffected, so the hard number stays correct.
 */
function sessionPath(): string {
  return join(stateDir(), "sessions", `${todayIso()}.json`)
}

function readTurns(): unknown[] {
  const doc = readJson<{ turns?: unknown[] }>(sessionPath(), {})
  return Array.isArray(doc.turns) ? doc.turns : []
}

/**
 * Persist the summary so the journal can aggregate it later. Same shape
 * of decision as feynman_summaries[]: the session file is the archive,
 * the journal is the view.
 */
function appendSummary(summary: ImmersiveReport.Summary): void {
  const p = sessionPath()
  try {
    StateIO.withLock(`${p}.lock`, () => {
      const doc = readJson<Record<string, unknown>>(p, { date: todayIso(), turns: [] })
      const list = Array.isArray(doc["immersive_summaries"])
        ? (doc["immersive_summaries"] as unknown[])
        : []
      list.push(summary)
      doc["immersive_summaries"] = list
      StateIO.writeJsonAtomic(p, doc)
    })
  } catch {
    // The report is already on screen; losing the archive copy must not
    // take the command down with it.
  }
}

function cmdOff(): void {
  const profile = requireProfile()
  const now = new Date()
  const existing = readState(profile)

  if (!existing || existing.active !== true) {
    process.stdout.write("immersive: already off\n")
    return
  }

  const expired = Immersive.hasExpired(existing, now)
  const summary = ImmersiveReport.build(
    existing,
    readTurns() as Array<{ ts?: string; hint_level?: number; user_wrote?: boolean | null }>,
    now,
    expired ? "timebox" : "manual",
  )

  mutate((p) => {
    delete p["immersive"]
  })
  appendSummary(summary)

  process.stdout.write(ImmersiveReport.render(summary) + "\n")
}

function cmdStatus(): void {
  const profile = requireProfile()
  const now = new Date()
  const existing = readState(profile)

  if (!Immersive.isActive(existing, now)) {
    process.stdout.write("immersive: off\n")
    return
  }

  const state = existing!
  const left = Immersive.remainingMinutes(state, now)
  const unlocked = Immersive.isUnlocked(state, now)

  const lines = [
    "immersive: ON",
    `elapsed: ${Immersive.elapsedMinutes(state, now)} min`,
    `remaining: ${left === null ? "(no timebox)" : `${left} min`}`,
    `unlocks used: ${Array.isArray(state.unlocks) ? state.unlocks.length : 0}`,
  ]
  if (unlocked) {
    lines.push(`UNLOCKED right now: ${Immersive.unlockRemainingMinutes(state, now)} min left`)
  }
  process.stdout.write(lines.join("\n") + "\n")
}

/**
 * Deliberate, logged escape hatch. Real work has real deadlines, and a
 * lock with no exit is a lock the user removes by uninstalling. The log
 * is the point: it turns "I gave up" into a number the autonomy report
 * can show honestly. Never scold on this path.
 */
function cmdUnlock(args: Args): void {
  const profile = requireProfile()
  const now = new Date()
  const existing = readState(profile)

  if (!Immersive.isActive(existing, now)) {
    process.stderr.write("error: immersive mode is not active — nothing to unlock.\n")
    process.exit(2)
  }

  const reason = (args.reason ?? "").trim()
  if (!reason) {
    process.stderr.write('error: a reason is required, e.g. --reason "prod hotfix"\n')
    process.exit(2)
  }

  let minutes = Immersive.DEFAULT_UNLOCK_MINUTES
  if (args.minutes !== undefined) {
    if (!Number.isFinite(args.minutes) || args.minutes <= 0) {
      process.stderr.write("error: --minutes must be a positive number\n")
      process.exit(2)
    }
    minutes = Math.round(args.minutes)
  }

  const updated = Immersive.addUnlock(existing!, now, reason, minutes)
  mutate((p) => {
    p["immersive"] = updated
  })

  process.stdout.write(
    `unlocked for ${minutes} min — reason: ${reason}\n` +
      `the agent can write code again until it elapses. immersive resumes by itself after that.\n` +
      `unlocks this session: ${updated.unlocks.length}\n`,
  )
}

/**
 * Grant a scaffold window. Requires immersive mode: with the gate open
 * the window means nothing, and granting it outside would just be a
 * confusing no-op.
 */
function cmdScaffold(args: Args): void {
  const profile = requireProfile()
  const now = new Date()
  const existing = readState(profile)

  if (!Immersive.isActive(existing, now)) {
    process.stderr.write(
      "error: scaffold needs immersive mode — outside it the agent already writes freely.\n" +
        "start one first: /socratiskill:socratic immersive 45\n",
    )
    process.exit(2)
  }

  if (Immersive.isScaffoldOpen(existing, now)) {
    const s = existing!.scaffold!
    process.stdout.write(
      `scaffold window already open: ${Immersive.scaffoldFilesLeft(s)} file(s) and ` +
        `${Immersive.scaffoldMinutesLeft(s, now)} min left\n`,
    )
    return
  }

  const level = Math.min(5, Math.max(1, Number(profile["global_level"]) || 3))
  let files = SCAFFOLD_FILES_BY_LEVEL[String(level)] ?? 5
  if (args.files !== undefined) {
    if (!Number.isFinite(args.files) || args.files <= 0) {
      process.stderr.write("error: file count must be a positive number\n")
      process.exit(2)
    }
    files = Math.round(args.files)
  }

  // A previously exhausted window is replaced, not stacked: its counts
  // move to history first so the report keeps the full picture.
  const base = existing!.scaffold ? Immersive.closeScaffold(existing!) : existing!
  const updated: Immersive.State = {
    ...base,
    scaffold: Immersive.createScaffold(now, files, SCAFFOLD_MAX_LINES, SCAFFOLD_MINUTES),
  }
  mutate((p) => {
    p["immersive"] = updated
  })

  process.stdout.write(
    `scaffold window open: ${files} new file(s), max ${SCAFFOLD_MAX_LINES} lines each, ${SCAFFOLD_MINUTES} min\n` +
      "the agent may CREATE files that do not exist yet. editing existing ones stays blocked.\n" +
      "lines it writes are tracked and subtracted from your autonomy count.\n",
  )
}

function cmdScaffoldStatus(): void {
  const profile = requireProfile()
  const now = new Date()
  const existing = readState(profile)

  if (!Immersive.isScaffoldOpen(existing, now)) {
    process.stdout.write("scaffold: no window open\n")
    return
  }
  const s = existing!.scaffold!
  process.stdout.write(
    [
      "scaffold: open",
      `files: ${s.files_used} used, ${Immersive.scaffoldFilesLeft(s)} left (of ${s.files_allowed})`,
      `time: ${Immersive.scaffoldMinutesLeft(s, now)} min left`,
      `lines written by the agent: ${s.lines_written}`,
    ].join("\n") + "\n",
  )
}

function cmdScaffoldClose(): void {
  const profile = requireProfile()
  const existing = readState(profile)

  if (!existing || !existing.scaffold) {
    process.stdout.write("scaffold: no window open\n")
    return
  }
  const s = existing.scaffold
  const updated = Immersive.closeScaffold(existing)
  mutate((p) => {
    p["immersive"] = updated
  })
  process.stdout.write(
    `scaffold closed: ${s.files_used} file(s) created, ${s.lines_written} line(s) written by the agent\n`,
  )
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.scaffoldStatus) return cmdScaffoldStatus()
  if (args.scaffoldClose) return cmdScaffoldClose()
  if (args.scaffold) return cmdScaffold(args)
  if (args.on) return cmdOn(args)
  if (args.off) return cmdOff()
  if (args.status) return cmdStatus()
  if (args.unlock) return cmdUnlock(args)
  process.stderr.write(
    'error: expected --on [--minutes N] | --off | --status | --unlock --reason "<txt>" [--minutes N] | --scaffold [--files N] | --scaffold-status | --scaffold-close\n',
  )
  process.exit(2)
}

main()
