/**
 * build-journal.ts — journal generator (daily / weekly / monthly).
 *
 * Reads sessions/<date>.json for the requested period, aggregates by
 * topic, and categorizes into learned / struggled / practiced / taught.
 * Includes a snapshot of the error-map (Leitner status at the time of
 * invocation).
 *
 * Usage:
 *   bun run build-journal.ts --period today         # default
 *   bun run build-journal.ts --period week          # ISO week (Mon-Sun)
 *   bun run build-journal.ts --period month         # calendar month
 *
 * Side effects:
 *   - Rewrites journal/<file>.md with the regenerated content.
 *   - Prints the same content to stdout.
 *
 * Exit codes: always 0. "No turns" is a valid case — prints a placeholder.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type Period = "today" | "week" | "month"

interface TurnRecord {
  ts: string
  session_id: string
  turn_index: number
  topic: string | null
  correct: boolean | null
  hint_level: number
  user_level: number
  domain: string | null
  user_excerpt: string | null
  agent_excerpt: string | null
}

interface FeynmanSummary {
  topic: string
  started_at: string
  ended_at: string
  duration_minutes: number
  gap_count: number
  gaps: string[]
}

/** One day's autonomy snapshot. Mirrors AutonomyReport.Summary. */
interface AutonomySummary {
  date: string
  level: number
  lines_added: number | null
  lines_removed: number | null
  repo: string | null
  turns_total: number
  turns_user_wrote: number
  avg_rung: number | null
  escape_count: number
  escape_minutes: number
  escape_reasons: string[]
  agent_lines?: number
  agent_files?: number
}

interface SessionDoc {
  date: string
  turns: TurnRecord[]
  feynman_summaries?: FeynmanSummary[]
  autonomy_summaries?: AutonomySummary[]
}

interface ErrorMapEntry {
  topic: string
  domain: string | null
  fail_count: number
  success_count: number
  resolved: boolean
  leitner_box: number
  next_review_at: string | null
}

interface TopicStat {
  topic: string
  domain: string | null
  correct_count: number
  wrong_count: number
  null_count: number
  turns: number
  max_hint_level: number
}

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

function parseArgs(argv: string[]): { period: Period } {
  let period: Period = "today"
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--period" && i + 1 < argv.length) {
      const v = argv[i + 1]!
      if (v === "today" || v === "week" || v === "month") period = v
      else {
        process.stderr.write(`invalid --period: ${v} (expected today|week|month)\n`)
        process.exit(2)
      }
      i++
    }
  }
  return { period }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/** ISO week number of a date (Monday-based, 1-indexed). */
function isoWeek(d: Date): { year: number; week: number } {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = tmp.getUTCDay() || 7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return { year: tmp.getUTCFullYear(), week }
}

/** Monday (UTC) of the ISO week containing d. */
function startOfIsoWeek(d: Date): Date {
  const dayNum = d.getUTCDay() || 7
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() - (dayNum - 1))
  return monday
}

function dateToIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function sessionFilesForPeriod(period: Period, now: Date): string[] {
  const dir = join(stateDir(), "sessions")
  if (!existsSync(dir)) return []
  const allFiles = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  if (period === "today") {
    const iso = dateToIso(now)
    return allFiles.filter((f) => f === `${iso}.json`).map((f) => join(dir, f))
  }
  if (period === "week") {
    const monday = startOfIsoWeek(now)
    const days: string[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday)
      d.setUTCDate(monday.getUTCDate() + i)
      days.push(dateToIso(d))
    }
    return allFiles.filter((f) => days.includes(f.slice(0, 10))).map((f) => join(dir, f))
  }
  // month
  const prefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-`
  return allFiles.filter((f) => f.startsWith(prefix)).map((f) => join(dir, f))
}

function loadSessions(paths: string[]): SessionDoc[] {
  const out: SessionDoc[] = []
  for (const p of paths) {
    try {
      out.push(JSON.parse(readFileSync(p, "utf-8")) as SessionDoc)
    } catch {
      // skip malformed
    }
  }
  return out
}

function aggregateTopics(sessions: SessionDoc[]): TopicStat[] {
  const byKey = new Map<string, TopicStat>()
  for (const s of sessions) {
    for (const t of s.turns) {
      if (!t.topic) continue
      const key = `${t.topic}::${t.domain ?? "unknown"}`
      const existing = byKey.get(key) ?? {
        topic: t.topic,
        domain: t.domain,
        correct_count: 0,
        wrong_count: 0,
        null_count: 0,
        turns: 0,
        max_hint_level: 0,
      }
      existing.turns += 1
      existing.max_hint_level = Math.max(existing.max_hint_level, t.hint_level || 0)
      if (t.correct === true) existing.correct_count += 1
      else if (t.correct === false) existing.wrong_count += 1
      else existing.null_count += 1
      byKey.set(key, existing)
    }
  }
  return Array.from(byKey.values())
}

function gatherAutonomySummaries(sessions: SessionDoc[]): AutonomySummary[] {
  const out: AutonomySummary[] = []
  for (const s of sessions) {
    if (Array.isArray(s.autonomy_summaries)) out.push(...s.autonomy_summaries)
  }
  return out
}

function gatherFeynmanSummaries(sessions: SessionDoc[]): FeynmanSummary[] {
  const out: FeynmanSummary[] = []
  for (const s of sessions) {
    if (s.feynman_summaries) out.push(...s.feynman_summaries)
  }
  return out
}

function readErrorMap(): ErrorMapEntry[] {
  const p = join(stateDir(), "error-map.json")
  if (!existsSync(p)) return []
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return Object.values(raw as Record<string, ErrorMapEntry>)
    }
    return []
  } catch {
    return []
  }
}

function headerFor(period: Period, now: Date): string {
  if (period === "today") return `# Daily Journal — ${dateToIso(now)}`
  if (period === "week") {
    const { year, week } = isoWeek(now)
    const monday = startOfIsoWeek(now)
    const sunday = new Date(monday)
    sunday.setUTCDate(monday.getUTCDate() + 6)
    return `# Weekly Journal — ${year}-W${String(week).padStart(2, "0")} (${dateToIso(monday)} to ${dateToIso(sunday)})`
  }
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, "0")
  return `# Monthly Journal — ${y}-${m}`
}

function journalFilename(period: Period, now: Date): string {
  if (period === "today") return `daily-${dateToIso(now)}.md`
  if (period === "week") {
    const { year, week } = isoWeek(now)
    return `weekly-${year}-W${String(week).padStart(2, "0")}.md`
  }
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, "0")
  return `monthly-${y}-${m}.md`
}

function formatStat(s: TopicStat): string {
  const dom = s.domain ? ` (${s.domain})` : ""
  const counts: string[] = []
  if (s.correct_count > 0) counts.push(`${s.correct_count} correct`)
  if (s.wrong_count > 0) counts.push(`${s.wrong_count} wrong`)
  if (s.null_count > 0) counts.push(`${s.null_count} unevaluated`)
  const tail = counts.length > 0 ? ` — ${counts.join(", ")}` : ""
  const hint = s.max_hint_level > 0 ? ` [peak hint ${s.max_hint_level}]` : ""
  return `- ${s.topic}${dom}${tail}${hint}`
}

function buildMarkdown(period: Period, now: Date, sessions: SessionDoc[]): string {
  const lines: string[] = []
  lines.push(headerFor(period, now))
  lines.push("")
  lines.push(`_generated ${now.toISOString()}_`)
  lines.push("")

  const totalTurns = sessions.reduce((acc, s) => acc + s.turns.length, 0)
  if (
    totalTurns === 0 &&
    gatherFeynmanSummaries(sessions).length === 0 &&
    gatherAutonomySummaries(sessions).length === 0
  ) {
    const scope = period === "today" ? "today" : `this ${period}`
    lines.push(`No activity recorded ${scope}.`)
    return lines.join("\n") + "\n"
  }

  const stats = aggregateTopics(sessions)
  const learned = stats.filter((s) => s.wrong_count === 0 && s.correct_count > 0)
  const struggled = stats.filter((s) => s.wrong_count > 0)
  const practiced = stats.filter((s) => s.correct_count === 0 && s.wrong_count === 0 && s.null_count > 0)
  const feynman = gatherFeynmanSummaries(sessions)

  lines.push(`## Summary`)
  lines.push(`- sessions (files): ${sessions.length}`)
  lines.push(`- turns: ${totalTurns}`)
  lines.push(`- topics touched: ${stats.length}`)
  lines.push(`- learned: ${learned.length}, struggled: ${struggled.length}, practiced: ${practiced.length}`)
  lines.push(`- teach sessions: ${feynman.length}`)
  lines.push("")

  if (learned.length > 0) {
    lines.push(`## Learned`)
    for (const s of learned.sort((a, b) => b.correct_count - a.correct_count)) lines.push(formatStat(s))
    lines.push("")
  }

  if (struggled.length > 0) {
    lines.push(`## Struggled`)
    for (const s of struggled.sort((a, b) => b.wrong_count - a.wrong_count)) lines.push(formatStat(s))
    lines.push("")
  }

  if (practiced.length > 0) {
    lines.push(`## Practiced (unevaluated)`)
    for (const s of practiced.sort((a, b) => b.null_count - a.null_count)) lines.push(formatStat(s))
    lines.push("")
  }

  const autonomy = gatherAutonomySummaries(sessions)
  if (autonomy.length > 0) {
    // Plain totals, no goal and no gamification. The signal the user
    // actually asked for is the trend, so period-over-period comparison
    // is left to reading two journals side by side rather than to a
    // score this file would have to invent.
    const measured = autonomy.filter((s) => s.lines_added !== null)
    const added = measured.reduce((a, s) => a + (s.lines_added ?? 0), 0)
    const removed = measured.reduce((a, s) => a + (s.lines_removed ?? 0), 0)
    const escapes = autonomy.reduce((a, s) => a + (s.escape_count ?? 0), 0)
    const agentLines = autonomy.reduce((a, s) => a + (s.agent_lines ?? 0), 0)
    const agentFiles = autonomy.reduce((a, s) => a + (s.agent_files ?? 0), 0)
    const wrote = autonomy.reduce((a, s) => a + s.turns_user_wrote, 0)
    const turns = autonomy.reduce((a, s) => a + s.turns_total, 0)
    const rungs = autonomy.filter((s) => s.avg_rung !== null).map((s) => s.avg_rung as number)
    const avgRung =
      rungs.length > 0 ? Math.round((rungs.reduce((a, b) => a + b, 0) / rungs.length) * 10) / 10 : null

    // Time spent on the off ramp is the ONLY signal available for the
    // risk that level 6 quietly becomes a permanent escape and hollows
    // the plugin out (RU-2). Reported plainly, never scolded.
    const offRampDays = autonomy.filter((s) => s.level === 6).length

    lines.push(`## Autonomy`)
    lines.push(`- days recorded: ${autonomy.length}`)
    if (measured.length > 0) {
      lines.push(`- you wrote: +${added} / -${removed} lines`)
    }
    if (measured.length < autonomy.length) {
      lines.push(`- ${autonomy.length - measured.length} day(s) not measured (no git repo at the working location)`)
    }
    if (agentFiles > 0) {
      lines.push(`- created by the agent: +${agentLines} lines across ${agentFiles} file(s), excluded above`)
    }
    lines.push(`- turns where you produced code: ${wrote} / ${turns}`)
    if (avgRung !== null) lines.push(`- average ladder rung: ${avgRung} (lower = less help needed)`)
    lines.push(`- escapes: ${escapes}`)
    if (escapes > 0) {
      const reasons = autonomy.flatMap((s) => s.escape_reasons ?? [])
      for (const r of reasons.slice(0, 10)) lines.push(`  - ${r}`)
    }
    if (offRampDays > 0) {
      lines.push(`- days at level 6 (axis off, not measured): ${offRampDays}`)
    }
    lines.push("")
  }

  if (feynman.length > 0) {
    lines.push(`## Feynman teach sessions`)
    for (const f of feynman) {
      lines.push(`- ${f.topic} — ${f.duration_minutes}min, ${f.gap_count} gaps`)
      for (const gap of f.gaps) lines.push(`  - gap: ${gap}`)
    }
    lines.push("")
  }

  const errorMap = readErrorMap()
  if (errorMap.length > 0) {
    const resolved = errorMap.filter((e) => e.resolved).length
    const now = Date.now()
    const due = errorMap.filter((e) => !e.resolved && e.next_review_at && Date.parse(e.next_review_at) <= now)
    const upcoming = errorMap.filter((e) => !e.resolved && e.next_review_at && Date.parse(e.next_review_at) > now)
    lines.push(`## Leitner snapshot (at generation time)`)
    lines.push(`- total cards: ${errorMap.length} (resolved: ${resolved}, due now: ${due.length}, upcoming: ${upcoming.length})`)
    if (due.length > 0) {
      lines.push(`- due:`)
      for (const e of due.slice(0, 10)) {
        lines.push(`  - ${e.topic} (${e.domain ?? "?"}, fails=${e.fail_count}, box=${e.leitner_box})`)
      }
    }
    lines.push("")
  }

  return lines.join("\n")
}

function main(): void {
  const { period } = parseArgs(process.argv.slice(2))
  const now = new Date()
  const files = sessionFilesForPeriod(period, now)
  const sessions = loadSessions(files)

  const md = buildMarkdown(period, now, sessions)

  const journalDir = join(stateDir(), "journal")
  ensureDir(journalDir)
  const outPath = join(journalDir, journalFilename(period, now))
  writeFileSync(outPath, md)

  process.stdout.write(md)
  process.stdout.write(`\n_written to ${outPath}_\n`)
}

main()
