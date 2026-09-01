/**
 * status.ts — the single control panel.
 *
 * v0.4 answered "what is my setup?" across four places: the level, the
 * mode, whether immersive was on, and whether a scaffold window was
 * open. A user who wanted less help had to know which of those to move.
 * There is one axis now, so there is one place to read it.
 *
 * Three sections, in the order a user actually asks about them:
 *
 *   THE AXIS      what level, what that means, what you may author
 *   EPISODE       drill / feynman / review, if one is running
 *   TODAY         budget spent, escapes, and the autonomy number
 *
 * The autonomy line is deliberately plain: no badges, no streaks, no
 * congratulation, and no softening of a low count. An honest number the
 * user can act on is the product — the same reason the calibration
 * grader defaults to fail.
 *
 * Level 6 is ALWAYS reported by name (rule R6.5). Keeping it out of the
 * user-facing docs discourages discovery; it does not license hiding the
 * state from someone who has already turned it on.
 */

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Axis } from "./axis-state"
import { AutonomyReport } from "./autonomy-report"
import LEVELS_JSON from "../data/levels.json"

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

const LEVEL_TABLE: Axis.LevelTable | null = (() => {
  try {
    return (LEVELS_JSON as { levels?: Axis.LevelTable }).levels ?? null
  } catch {
    return null
  }
})()

interface TurnLike {
  ts?: string
  hint_level?: number
  user_wrote?: boolean | null
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return fallback
  }
}

function main(): void {
  const dir = stateDir()

  if (existsSync(join(dir, "profile.json.paused"))) {
    process.stdout.write("socratiskill: PAUSED (run `/socratiskill:socratic resume`)\n")
    return
  }

  const profilePath = join(dir, "profile.json")
  if (!existsSync(profilePath)) {
    process.stderr.write("no profile found; run /socratiskill:socratic calibrate first\n")
    process.exit(3)
  }

  const profile = readJson<Record<string, unknown>>(profilePath, {})
  const now = new Date()
  const day = Axis.dayKey(now)

  if (profile["enabled"] === false) {
    process.stdout.write("socratiskill: DISABLED (run `/socratiskill:socratic on`)\n")
    return
  }

  const level = Axis.readLevel(profile["global_level"])
  const spec = Axis.spec(level, LEVEL_TABLE)
  const budget = Axis.currentBudget(profile["axis_budget"] as Axis.Budget | undefined, now)
  const escapes = (profile["escapes"] as Axis.Escape[] | undefined) ?? []
  const escaped = Axis.isEscapeActive(escapes, now)
  const offRamp = Axis.isOffRamp(level)
  const armed = !escaped && !offRamp && spec.may_edit_existing === false

  const out: string[] = []

  // --- the axis ------------------------------------------------------------
  out.push(`level ${level} — ${spec.label}`)
  out.push(`  ${spec.summary}`)

  if (offRamp) {
    out.push("  the axis is OFF at this level: no pedagogy, no calibration, no autonomy measurement.")
    out.push("  the axis itself lives at levels 1-5.")
  } else if (level === Axis.MIN_LEVEL) {
    out.push("  you author nothing at this level; the agent writes and questions you as it goes.")
  } else {
    const left = Axis.remainingFiles(level, budget, now, LEVEL_TABLE)
    out.push(
      `  agent may create new files: ${left === null ? "unlimited" : `${left} left today`}` +
        `, max ${spec.statements_per_file} executable statement(s) each`,
    )
    out.push("  agent may NOT edit files that already exist")
    out.push(`  hint rungs in play: ${spec.rung_min}-${spec.rung_max} · handoff by ${spec.handoff}`)
  }

  if (profile["calibration_completed"] !== true) {
    out.push("  not calibrated yet — run `/socratiskill:socratic calibrate`")
  }
  const pendingDiag = profile["pending_diagnostic"]
  if (pendingDiag && typeof pendingDiag === "object") {
    const target = (pendingDiag as Record<string, unknown>)["target_level"]
    out.push(`  diagnostic in progress toward level ${target}`)
  }

  // --- episode -------------------------------------------------------------
  const session = readJson<Record<string, unknown>>(join(dir, "sessions", `${day}.json`), {})
  const episodes: string[] = []

  const drill = session["drill"] as Record<string, unknown> | undefined
  if (drill) episodes.push(`drill ${drill["kind"]}${drill["file"] ? ` on ${drill["file"]}` : ""}`)

  const feynman = session["feynman"] as Record<string, unknown> | undefined
  if (feynman) {
    const gaps = Array.isArray(feynman["gaps"]) ? (feynman["gaps"] as unknown[]).length : 0
    episodes.push(`feynman teaching "${feynman["topic"]}" (${gaps} gap(s) logged)`)
  }

  const handoff = session["handoff"] as Record<string, unknown> | undefined
  if (handoff) episodes.push(`unit in flight: "${handoff["unit"]}"`)

  out.push("")
  if (episodes.length === 0) {
    out.push("episode: none")
  } else {
    out.push("episode:")
    for (const e of episodes) out.push(`  ${e}`)
  }

  // --- today ---------------------------------------------------------------
  out.push("")
  out.push(`today (${day}):`)

  if (escaped) {
    const last = escapes[escapes.length - 1]!
    out.push(`  escape OPEN — ${Axis.escapeRemainingMinutes(escapes, now)} min left ("${last.reason}")`)
  }
  const todaysEscapes = escapes.filter((e) => typeof e.at === "string" && e.at.slice(0, 10) === day)
  out.push(`  escapes: ${todaysEscapes.length}`)

  if (armed || (!offRamp && level !== Axis.MIN_LEVEL)) {
    out.push(`  agent created: ${budget.files_used} file(s), ${budget.lines_written} line(s)`)
  }

  const turns = (session["turns"] as TurnLike[] | undefined) ?? []
  const baselines = (profile["git_baselines"] as AutonomyReport.Baselines | undefined) ?? {}
  const cwd = process.env["SOCRATIC_CWD"] ?? process.cwd()
  const repo = AutonomyReport.repoRoot(cwd)
  const baseline = repo ? baselines[repo] ?? null : null

  const summary = AutonomyReport.build({
    day,
    level,
    turns,
    baseline: baseline && baseline.date === day ? baseline : null,
    escapes: todaysEscapes,
    agentLines: budget.lines_written,
    agentFiles: budget.files_used,
  })

  out.push("")
  out.push(AutonomyReport.render(summary))

  process.stdout.write(out.join("\n") + "\n")
}

main()
