/**
 * axis-state.ts — pure state logic for THE axis.
 *
 * Replaces immersive-state.ts. The v0.4 design had three independent
 * pedagogical axes (level 1-5, mode learn|productive, immersive on|off)
 * plus two escape valves (unlock, scaffold). They were not really
 * independent: in all five levels the agent wrote the code, and level
 * only varied how much it explained. The axis measured PEDAGOGICAL
 * OVERHEAD, never authorship — so "you type this one" had nowhere to
 * live and had to be bolted on as a separate mode, which then needed
 * its own valve, its own window, its own timebox and its own report.
 *
 * Here there is one axis and it answers one question:
 *
 *     HOW MUCH OF THE WORK IS THE USER'S?
 *
 * Everything else falls out of it. See unificacion.txt section 12.B for
 * the frozen contract and data/levels.json for the numbers.
 *
 * Level 6 is NOT on this axis — it is the axis switched off. It is kept
 * out of every clamp and every promotion path on purpose; see
 * `clampToAxis` and `isOffRamp`.
 *
 * This module is pure (no I/O) so the CLI, the UserPromptSubmit hook
 * (build-context.ts) and the PreToolUse gate (gate-tool.ts) share one
 * definition of what each level permits. Mirrors the hint-state.ts and
 * immersive-state.ts split that preceded it.
 */

export namespace Axis {
  export type Authorship = "full" | "structure+trivial" | "skeleton" | "none"
  export type Handoff = "none" | "module" | "unit" | "subproblem"

  export interface LevelSpec {
    key: string
    label: string
    authorship: Authorship
    summary: string
    /** null = unlimited. */
    files_per_day: number | null
    /** null = unlimited. */
    statements_per_file: number | null
    may_edit_existing: boolean
    rung_min: number | null
    rung_max: number | null
    handoff: Handoff
    rules: string
  }

  export type LevelTable = Record<string, LevelSpec>

  export const MIN_LEVEL = 1
  export const MAX_LEVEL = 5
  export const OFF_RAMP = 6
  export const DEFAULT_LEVEL = 3

  /**
   * Used only when data/levels.json is missing or unreadable. Same idiom
   * as the algorithm.json consumers: the JSON is the tunable source of
   * truth, this is the safety net so a corrupt data file degrades to
   * sane behavior instead of taking the gate down with it.
   *
   * Keep in sync with data/levels.json. The JSON wins whenever present.
   */
  export const FALLBACK: LevelTable = {
    "1": {
      key: "implementer",
      label: "Implementer",
      authorship: "full",
      summary: "The agent implements; you read and get questioned.",
      files_per_day: null,
      statements_per_file: null,
      may_edit_existing: true,
      rung_min: 5,
      rung_max: 5,
      handoff: "none",
      rules: "level-1-implementer.md",
    },
    "2": {
      key: "framer",
      label: "Framer",
      authorship: "structure+trivial",
      summary: "The agent frames structure and trivial bodies; you write the load-bearing logic.",
      files_per_day: 8,
      statements_per_file: 8,
      may_edit_existing: false,
      rung_min: 4,
      rung_max: 5,
      handoff: "module",
      rules: "level-2-framer.md",
    },
    "3": {
      key: "architect",
      label: "Architect",
      authorship: "skeleton",
      summary: "The agent writes skeletons and signatures; every body is yours.",
      files_per_day: 6,
      statements_per_file: 0,
      may_edit_existing: false,
      rung_min: 3,
      rung_max: 4,
      handoff: "unit",
      rules: "level-3-architect.md",
    },
    "4": {
      key: "guide",
      label: "Guide",
      authorship: "none",
      summary: "The agent writes nothing; it breaks the problem down and points at prior art in your repo.",
      files_per_day: 4,
      statements_per_file: 0,
      may_edit_existing: false,
      rung_min: 2,
      rung_max: 3,
      handoff: "subproblem",
      rules: "level-4-guide.md",
    },
    "5": {
      key: "socratic",
      label: "Socratic",
      authorship: "none",
      summary: "The agent writes nothing and directs nothing. It asks.",
      files_per_day: 3,
      statements_per_file: 0,
      may_edit_existing: false,
      rung_min: 0,
      rung_max: 1,
      handoff: "none",
      rules: "level-5-socratic.md",
    },
    "6": {
      key: "autopilot",
      label: "Autopilot",
      authorship: "full",
      summary: "The axis is off. Plain code assistant, no pedagogy.",
      files_per_day: null,
      statements_per_file: null,
      may_edit_existing: true,
      rung_min: null,
      rung_max: null,
      handoff: "none",
      rules: "level-6-autopilot.md",
    },
  }

  // --- level identity ------------------------------------------------------

  /**
   * 6 is the off ramp, not a sixth rung of the ladder. Every consumer
   * that assumes the axis is monotonic ("higher = more of the work is
   * yours") must ask this FIRST and take a different path, rather than
   * reading 6 as "even more than 5" — which is the exact opposite of
   * what it means.
   */
  export function isOffRamp(level: number): boolean {
    return Math.round(level) === OFF_RAMP
  }

  /** A level the user may actually set: the axis, plus the off ramp. */
  export function isSettable(level: number): boolean {
    const n = Math.round(level)
    return (n >= MIN_LEVEL && n <= MAX_LEVEL) || n === OFF_RAMP
  }

  /**
   * Clamp to the PEDAGOGICAL axis, excluding the off ramp. Every
   * automatic path — continuous calibration, the diagnostic gate,
   * `accept` — must run its result through this.
   *
   * Rule R6.1: calibration can never promote to 6. A plugin whose
   * purpose is fighting skill atrophy, and which rewards demonstrated
   * competence by handing the keyboard back to the agent, sabotages
   * itself. The off ramp is reachable by typing it and no other way.
   *
   * From 6, clamping lands on MAX_LEVEL rather than on the nearest
   * number, because someone leaving the off ramp is returning to the
   * top of the axis, not to the middle of it.
   */
  export function clampToAxis(level: number): number {
    const n = Math.round(level)
    if (n >= OFF_RAMP) return MAX_LEVEL
    if (n < MIN_LEVEL) return MIN_LEVEL
    if (n > MAX_LEVEL) return MAX_LEVEL
    return n
  }

  /**
   * The ONE way to read global_level out of a profile. Use it everywhere.
   *
   * Every reader in v0.4 open-coded `Math.min(5, Math.max(1, n || 3))`,
   * which was correct when the axis ended at 5 and is a silent disaster
   * now: it maps a level-6 profile to 5, and under the new axis 5 means
   * "writes nothing, asks only" — the exact opposite of what 6 means.
   * The user would get the most restrictive setting while believing they
   * had turned the axis off, and nothing would report an error.
   *
   * Clamping is for CALIBRATION (clampToAxis), never for reading.
   */
  export function readLevel(raw: unknown): number {
    const n = Math.round(Number(raw))
    if (!Number.isFinite(n)) return DEFAULT_LEVEL
    if (n === OFF_RAMP) return OFF_RAMP
    if (n < MIN_LEVEL) return MIN_LEVEL
    if (n > MAX_LEVEL) return DEFAULT_LEVEL
    return n
  }

  export function spec(level: number, table?: LevelTable | null): LevelSpec {
    const t = table && typeof table === "object" ? table : FALLBACK
    const n = Math.round(level)
    const key = String(isSettable(n) ? n : DEFAULT_LEVEL)
    return t[key] ?? FALLBACK[key] ?? FALLBACK[String(DEFAULT_LEVEL)]!
  }

  // --- authorship ----------------------------------------------------------

  /** The agent may create files that do not exist yet. */
  export function mayCreateFiles(level: number, table?: LevelTable | null): boolean {
    const s = spec(level, table)
    return s.files_per_day === null || s.files_per_day > 0
  }

  /**
   * The create-vs-edit line. This is the ONLY authorship boundary the
   * gate can draw without adjudicating, and the whole design rests on
   * it: "is this boilerplate or is this the code that teaches them?" is
   * a judgment call, and a judgment call handed to the model is one its
   * helpfulness gradient widens until it swallows the feature. Whether
   * a file already exists is a fact.
   */
  export function mayEditExisting(level: number, table?: LevelTable | null): boolean {
    return spec(level, table).may_edit_existing === true
  }

  /** null = unlimited. */
  export function statementAllowance(level: number, table?: LevelTable | null): number | null {
    return spec(level, table).statements_per_file
  }

  /** null = unlimited. */
  export function filesPerDay(level: number, table?: LevelTable | null): number | null {
    return spec(level, table).files_per_day
  }

  // --- rung range ----------------------------------------------------------

  /**
   * The level bounds the ladder; the rung moves inside those bounds.
   *
   * Two different timescales, and collapsing them was tempting and
   * wrong: the LEVEL is a stable band that moves by calibration over
   * days, the RUNG is the reaction inside a single problem that climbs
   * after two consecutive failures and comes back down. Folding the
   * rung into the level would mean getting stuck on one bug demotes
   * you — exactly the noise the weighted calibration of Fase 12 was
   * built to remove.
   */
  export function clampRung(level: number, rung: number, table?: LevelTable | null): number {
    const s = spec(level, table)
    if (s.rung_min === null || s.rung_max === null) return Math.max(0, Math.min(5, Math.round(rung)))
    const n = Math.round(rung)
    if (n < s.rung_min) return s.rung_min
    if (n > s.rung_max) return s.rung_max
    return n
  }

  // --- the ladder ----------------------------------------------------------

  /**
   * The 0-5 rungs, in the sense the axis gives them: "more help" can no
   * longer mean "more code", because at L2-L5 the agent does not write
   * the bodies. The ceiling is a work order, never an implementation, so
   * rung 5 is the one to keep honest.
   *
   * One-liners here are what gets injected per turn; the long version
   * with GOOD/BAD examples lives in rules/ladder.md. This is the single
   * source — the rules file expands it, it does not redefine it.
   */
  export const LADDER: Record<number, { name: string; directive: string }> = {
    0: {
      name: "Pure socratic",
      directive: "Ask only. \"¿Cómo lo abordarías?\" \"¿Qué archivo tocarías?\" Give nothing else.",
    },
    1: {
      name: "Orientation",
      directive: "Name the area, file, or module where the problem lives. Do not say what to do there.",
    },
    2: {
      name: "Analogy",
      directive: "Point at an analogous case ALREADY SOLVED in this repo: \"esto se parece a lo que hiciste en X\". Make them go read it.",
    },
    3: {
      name: "Reduction",
      directive: "Break the problem into ordered subproblems. They solve each one. Do not solve the first to \"show how\".",
    },
    4: {
      name: "Explanation + verification",
      directive: "Explain the approach in prose, then make them restate it in their own words BEFORE they start typing.",
    },
    5: {
      name: "Work order",
      directive:
        "Full spec: files to touch, function signatures, acceptance criteria, edge cases, implementation order. STILL NOT CODE — no code blocks, no line-by-line pseudocode, no function bodies.",
    },
  }

  export function rung(n: number): { name: string; directive: string } {
    const i = Math.max(0, Math.min(5, Math.round(n)))
    return LADDER[i] ?? LADDER[3]!
  }

  // --- daily budget --------------------------------------------------------

  /**
   * Layer 2 of the RU-3 mitigation: it does not prevent the agent from
   * smuggling an implementation into a new file, it bounds the blast
   * radius when it does.
   *
   * Replaces the v0.4 user-granted scaffold window. The grant existed
   * because the model cannot be trusted to draw the boilerplate line —
   * but the gate never needed the model's opinion, only a fact (does
   * the file exist) and a counter. A budget gives the same bound with
   * no ceremony and nothing for the model to talk the user into.
   */
  export interface Budget {
    /** UTC date key, YYYY-MM-DD. */
    date: string
    files_used: number
    lines_written: number
  }

  /**
   * UTC, deliberately, and never the local date.
   *
   * Session files are written with toISOString() (UTC) while `date` in a
   * shell resolves to LOCAL time. Mixing them made five asserts fail
   * only between 17:00 and midnight in a UTC-7 zone, latent for two
   * phases before anyone ran the suite in that window. Anything that
   * keys state by day in this codebase uses UTC.
   */
  export function dayKey(now: Date): string {
    return now.toISOString().slice(0, 10)
  }

  export function freshBudget(now: Date): Budget {
    return { date: dayKey(now), files_used: 0, lines_written: 0 }
  }

  /** A budget from a previous day is spent, not carried: it is reset. */
  export function currentBudget(budget: Budget | undefined | null, now: Date): Budget {
    if (!budget || typeof budget !== "object") return freshBudget(now)
    if (budget.date !== dayKey(now)) return freshBudget(now)
    return {
      date: budget.date,
      files_used: Number(budget.files_used) || 0,
      lines_written: Number(budget.lines_written) || 0,
    }
  }

  /** null = unlimited. */
  export function remainingFiles(
    level: number,
    budget: Budget | undefined | null,
    now: Date,
    table?: LevelTable | null,
  ): number | null {
    const allowed = filesPerDay(level, table)
    if (allowed === null) return null
    const b = currentBudget(budget, now)
    return Math.max(0, allowed - b.files_used)
  }

  export function hasBudgetLeft(
    level: number,
    budget: Budget | undefined | null,
    now: Date,
    table?: LevelTable | null,
  ): boolean {
    const left = remainingFiles(level, budget, now, table)
    return left === null || left > 0
  }

  /**
   * Charged on ALLOW, not on completion — if the write fails downstream
   * the budget is still spent. That error runs in the user's favor and
   * is documented rather than fixed with a fourth hook. A denial never
   * charges (invariant I4): being told no is not a use of the budget.
   */
  export function chargeFile(budget: Budget | undefined | null, now: Date, lines: number): Budget {
    const b = currentBudget(budget, now)
    return {
      date: b.date,
      files_used: b.files_used + 1,
      lines_written: b.lines_written + Math.max(0, Math.round(lines)),
    }
  }

  // --- escape --------------------------------------------------------------

  /**
   * The deduplication of v0.4's `unlock` and `mode: productive`. Both
   * meant the same thing — "I need to ship right now, get out of the
   * way" — and having one persistent and one temporary was an accident
   * of them being invented for different axes.
   *
   * What survives from unlock: a mandatory reason, an expiry, a log,
   * and honesty in the report (lines written during an escape cannot be
   * attributed, so the report says so instead of implying a clean
   * number). What survives from productive: while it is open the agent
   * actually produces, with no pedagogical overhead.
   *
   * Never editorialize when the user opens one. No "are you sure", no
   * reminder about their goals, no disappointment. Real work has real
   * deadlines, and a lock with no exit gets the plugin uninstalled the
   * first Friday it gets in the way. The log is the accountability; the
   * model's commentary is not. Flattery and scolding are the same error
   * of not respecting the user's decision.
   */
  export interface Escape {
    at: string
    reason: string
    minutes: number
  }

  export const DEFAULT_ESCAPE_MINUTES = 10

  export function createEscape(now: Date, reason: string, minutes: number): Escape {
    return {
      at: now.toISOString(),
      reason,
      minutes: Math.max(1, Math.round(minutes)),
    }
  }

  export function isEscapeActive(escapes: Escape[] | undefined | null, now: Date): boolean {
    if (!Array.isArray(escapes) || escapes.length === 0) return false
    const last = escapes[escapes.length - 1]
    if (!last) return false
    const at = Date.parse(last.at)
    if (Number.isNaN(at)) return false
    return now.getTime() < at + Math.max(0, last.minutes) * 60_000
  }

  export function escapeRemainingMinutes(escapes: Escape[] | undefined | null, now: Date): number {
    if (!isEscapeActive(escapes, now)) return 0
    const last = escapes![escapes!.length - 1]!
    const at = Date.parse(last.at)
    return Math.max(0, Math.ceil((at + last.minutes * 60_000 - now.getTime()) / 60_000))
  }

  // --- gate summary --------------------------------------------------------

  /**
   * Everything the gate needs to decide, derived from the level in one
   * place so the gate never re-implements the contract.
   *
   * `armed: false` means the axis imposes nothing — L1 (the agent is
   * supposed to write), L6 (the axis is off) or an open escape. All
   * three are fail-open by construction: a gate that blocks real work
   * by mistake gets uninstalled, so every uncertain path ends here.
   */
  export interface GateContract {
    armed: boolean
    level: number
    label: string
    mayEditExisting: boolean
    mayCreateFiles: boolean
    statementAllowance: number | null
    remainingFiles: number | null
    maxLinesPerFile: number
  }

  export function gateContract(
    level: number,
    budget: Budget | undefined | null,
    escapes: Escape[] | undefined | null,
    now: Date,
    maxLinesPerFile: number,
    table?: LevelTable | null,
  ): GateContract {
    const s = spec(level, table)
    const escaped = isEscapeActive(escapes, now)
    const armed = !escaped && !isOffRamp(level) && s.may_edit_existing === false
    return {
      armed,
      level: Math.round(level),
      label: s.label,
      mayEditExisting: !armed,
      mayCreateFiles: mayCreateFiles(level, table),
      statementAllowance: s.statements_per_file,
      remainingFiles: remainingFiles(level, budget, now, table),
      maxLinesPerFile: Math.max(1, Math.round(maxLinesPerFile)),
    }
  }
}
