/**
 * immersive-state.ts — pure state logic for the immersive operating mode.
 *
 * Immersive mode is a THIRD axis, orthogonal to level (1-5) and mode
 * (learn|productive). Those two only ever varied how much the agent
 * explains while it writes your code. This one changes who holds the
 * keyboard: while immersive is active the agent does not write code at
 * all — the user does, and the agent coaches up the immersive ladder.
 *
 * Scope decision: session-based with an optional timebox. Immersive is
 * deliberate training, not a permanent setting — a global always-on mode
 * gets switched off the first time a deadline shows up, and then the
 * whole thing dies. See inmersivo.txt section 3 (D1).
 *
 * This module is pure (no I/O) so both the CLI (immersive.ts) and the
 * UserPromptSubmit hook (build-context.ts) share one definition of what
 * "active" means. Mirrors the hint-state.ts split.
 */

export namespace Immersive {
  export interface Unlock {
    at: string
    reason: string
    minutes: number
  }

  /**
   * A scaffold window: the user explicitly conceding that the agent may
   * create the skeleton of something new.
   *
   * Typing an empty index.html teaches nothing — it is not the muscle
   * this mode exists to rebuild — so refusing it is friction with no
   * pedagogical return, and friction with no return is how the mode
   * gets uninstalled.
   *
   * The window is granted by a COMMAND, never inferred from prose. The
   * boundary between "boilerplate" and "the code that teaches you" is
   * not definable in code, so it is never the model's call to make:
   * the model may suggest the command, only the user may run it.
   */
  export interface Scaffold {
    granted_at: string
    expires_at: string
    files_allowed: number
    files_used: number
    max_lines_per_file: number
    lines_written: number
  }

  export interface ScaffoldRecord {
    granted_at: string
    files_allowed: number
    files_used: number
    lines_written: number
  }

  export interface State {
    active: boolean
    started_at: string
    /** null = no timebox (runs until `immersive off`). */
    expires_at: string | null
    unlocks: Unlock[]
    /** Hint rung when the session opened, for the autonomy report. */
    baseline_hint: number
    /**
     * Git state at activation, so the report can measure what the user
     * actually wrote. Captured by the CLI (this module stays pure) and
     * null when the session did not start inside a repo.
     */
    git_baseline?: {
      repo: string
      head: string | null
      added: number
      removed: number
    } | null
    /** The window currently open, if any. */
    scaffold?: Scaffold | null
    /**
     * Closed windows. Kept apart from `unlocks` on purpose: scaffolding
     * is a legitimate part of the workflow, giving up is not, and one
     * counter cannot mean both without becoming useless.
     */
    scaffolds?: ScaffoldRecord[]
  }

  export const DEFAULT_UNLOCK_MINUTES = 10

  /**
   * The immersive ladder: the same 0-5 rungs that hint-state.ts already
   * escalates (+1 after two consecutive failures, straight to 5 on a
   * zero-knowledge signal), re-read for a mode where the agent never
   * types. The ceiling is a work order, NEVER code — that inversion is
   * the whole point, so rung 5 is the one to keep honest.
   *
   * Detailed GOOD/BAD examples live in rules/immersive-ladder.md; these
   * one-liners are what gets injected per turn.
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

  export function rung(level: number): { name: string; directive: string } {
    const n = Math.max(0, Math.min(5, Math.round(level)))
    return LADDER[n] ?? LADDER[3]!
  }

  export function create(now: Date, minutes: number | null, baselineHint: number): State {
    return {
      active: true,
      started_at: now.toISOString(),
      expires_at: minutes === null ? null : new Date(now.getTime() + minutes * 60_000).toISOString(),
      unlocks: [],
      baseline_hint: baselineHint,
    }
  }

  /**
   * A state is only active if the flag is set AND the timebox has not
   * elapsed. Callers must use this rather than reading `.active`, so an
   * expired session can never keep the gate closed — a stale lock the
   * user cannot open is the worst failure mode this feature has.
   */
  export function isActive(state: State | undefined | null, now: Date): boolean {
    if (!state || state.active !== true) return false
    return !hasExpired(state, now)
  }

  export function hasExpired(state: State | undefined | null, now: Date): boolean {
    if (!state || !state.expires_at) return false
    const t = Date.parse(state.expires_at)
    if (Number.isNaN(t)) return false
    return t <= now.getTime()
  }

  /** Minutes left, or null when the session has no timebox. */
  export function remainingMinutes(state: State, now: Date): number | null {
    if (!state.expires_at) return null
    const t = Date.parse(state.expires_at)
    if (Number.isNaN(t)) return null
    return Math.max(0, Math.ceil((t - now.getTime()) / 60_000))
  }

  export function elapsedMinutes(state: State, now: Date): number {
    const t = Date.parse(state.started_at)
    if (Number.isNaN(t)) return 0
    return Math.max(0, Math.round((now.getTime() - t) / 60_000))
  }

  /**
   * An unlock is a deliberate, logged escape hatch — real work has real
   * deadlines, and a lock with no exit gets the plugin uninstalled the
   * first Friday it gets in the way. Logged, never punished: the record
   * is what turns a defeat into a measurement.
   */
  export function isUnlocked(state: State | undefined | null, now: Date): boolean {
    if (!state || !Array.isArray(state.unlocks) || state.unlocks.length === 0) return false
    const last = state.unlocks[state.unlocks.length - 1]
    if (!last) return false
    const at = Date.parse(last.at)
    if (Number.isNaN(at)) return false
    return now.getTime() < at + Math.max(0, last.minutes) * 60_000
  }

  export function unlockRemainingMinutes(state: State, now: Date): number {
    if (!isUnlocked(state, now)) return 0
    const last = state.unlocks[state.unlocks.length - 1]!
    const at = Date.parse(last.at)
    return Math.max(0, Math.ceil((at + last.minutes * 60_000 - now.getTime()) / 60_000))
  }

  export function addUnlock(state: State, now: Date, reason: string, minutes: number): State {
    const unlocks = Array.isArray(state.unlocks) ? state.unlocks.slice() : []
    unlocks.push({ at: now.toISOString(), reason, minutes })
    return { ...state, unlocks }
  }

  export function createScaffold(
    now: Date,
    files: number,
    maxLinesPerFile: number,
    minutes: number,
  ): Scaffold {
    return {
      granted_at: now.toISOString(),
      expires_at: new Date(now.getTime() + minutes * 60_000).toISOString(),
      files_allowed: Math.max(1, Math.round(files)),
      files_used: 0,
      max_lines_per_file: Math.max(1, Math.round(maxLinesPerFile)),
      lines_written: 0,
    }
  }

  /**
   * Open means: granted, not expired, and files left. Closing on any of
   * the three keeps a forgotten window from quietly staying open for the
   * rest of a long session.
   */
  export function isScaffoldOpen(state: State | undefined | null, now: Date): boolean {
    const s = state?.scaffold
    if (!s) return false
    if (Number(s.files_used) >= Number(s.files_allowed)) return false
    const t = Date.parse(s.expires_at)
    if (!Number.isNaN(t) && t <= now.getTime()) return false
    return true
  }

  export function scaffoldFilesLeft(s: Scaffold): number {
    return Math.max(0, Number(s.files_allowed) - Number(s.files_used))
  }

  export function scaffoldMinutesLeft(s: Scaffold, now: Date): number {
    const t = Date.parse(s.expires_at)
    if (Number.isNaN(t)) return 0
    return Math.max(0, Math.ceil((t - now.getTime()) / 60_000))
  }

  /**
   * Every line the agent contributed through scaffold windows, open and
   * closed. The autonomy report subtracts this so the user's number
   * stays their own — the one thing unlock could never do, because
   * there the agent's work is indistinguishable in the same tree.
   */
  export function totalScaffoldLines(state: State | undefined | null): number {
    if (!state) return 0
    const closed = Array.isArray(state.scaffolds)
      ? state.scaffolds.reduce((a, r) => a + (Number(r.lines_written) || 0), 0)
      : 0
    const open = state.scaffold ? Number(state.scaffold.lines_written) || 0 : 0
    return closed + open
  }

  export function totalScaffoldWindows(state: State | undefined | null): number {
    if (!state) return 0
    const closed = Array.isArray(state.scaffolds) ? state.scaffolds.length : 0
    return closed + (state.scaffold ? 1 : 0)
  }

  /** Move the open window into history. Idempotent. */
  export function closeScaffold(state: State): State {
    const s = state.scaffold
    if (!s) return state
    const history = Array.isArray(state.scaffolds) ? state.scaffolds.slice() : []
    history.push({
      granted_at: s.granted_at,
      files_allowed: s.files_allowed,
      files_used: s.files_used,
      lines_written: s.lines_written,
    })
    const next: State = { ...state, scaffolds: history }
    delete next.scaffold
    return next
  }

  /** Shape guard for state read back off disk. */
  export function isState(v: unknown): v is State {
    if (!v || typeof v !== "object") return false
    const s = v as Record<string, unknown>
    return typeof s["active"] === "boolean" && typeof s["started_at"] === "string"
  }
}
