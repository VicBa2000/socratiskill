/**
 * immersive-report.ts — autonomy measurement for immersive sessions.
 *
 * The rest of this plugin measures comprehension: did the user understand
 * what they were shown. That was always a proxy. Immersive mode makes a
 * harder question answerable — how much of the code that landed did the
 * user actually produce — because while the gate is closed the agent
 * cannot write, so anything that appears in the working tree came from
 * their hands.
 *
 * Git is therefore the honest signal here, not model self-report. The
 * soft signals (ladder rung, unlocks, self-declared user_wrote) are
 * reported alongside it, never in place of it.
 *
 * Every git call is best-effort: outside a repo, or with git missing,
 * the summary degrades to the soft signals rather than failing.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Immersive } from "./immersive-state"

export namespace ImmersiveReport {
  export interface GitBaseline {
    repo: string
    head: string | null
    added: number
    removed: number
  }

  export interface Summary {
    started_at: string
    ended_at: string
    duration_minutes: number
    ended_by: "manual" | "timebox"
    /** null when the session did not run inside a git repo. */
    lines_added: number | null
    lines_removed: number | null
    repo: string | null
    turns_total: number
    turns_user_wrote: number
    /** Mean ladder rung across the session. Lower = less help needed. */
    avg_rung: number | null
    unlock_count: number
    unlock_minutes: number
    unlock_reasons: string[]
    /** Lines the agent contributed through scaffold windows. */
    scaffold_lines: number
    scaffold_windows: number
  }

  interface TurnLike {
    ts?: string
    hint_level?: number
    user_wrote?: boolean | null
  }

  function git(args: string[], cwd?: string): string | null {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    } catch {
      return null
    }
  }

  export function repoRoot(cwd: string): string | null {
    const out = git(["rev-parse", "--show-toplevel"], cwd)
    return out && out.length > 0 ? out : null
  }

  export function headSha(repo: string): string | null {
    return git(["rev-parse", "HEAD"], repo)
  }

  /** Sums a `--numstat` block, skipping binary files (which report "-"). */
  function sumNumstat(raw: string | null): { added: number; removed: number } {
    const out = { added: 0, removed: 0 }
    if (!raw) return out
    for (const line of raw.split("\n")) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 2) continue
      const a = Number(parts[0])
      const r = Number(parts[1])
      if (Number.isFinite(a)) out.added += a
      if (Number.isFinite(r)) out.removed += r
    }
    return out
  }

  /** Lines in files git does not track yet, honouring .gitignore. */
  function untrackedLines(repo: string): number {
    const list = git(["ls-files", "--others", "--exclude-standard"], repo)
    if (!list) return 0
    let total = 0
    // Bounded: --exclude-standard already drops ignored trees like
    // node_modules, but a pathological repo should not stall a hook.
    for (const rel of list.split("\n").filter((s) => s.length > 0).slice(0, 500)) {
      try {
        const raw = readFileSync(join(repo, rel), "utf-8")
        if (raw.length === 0 || raw.indexOf("\0") !== -1) continue
        const n = raw.split("\n").length
        total += raw.endsWith("\n") ? n - 1 : n
      } catch {
        /* unreadable or binary: skip */
      }
    }
    return total
  }

  /**
   * Uncommitted work relative to HEAD, including files git has not been
   * told about yet.
   *
   * `git diff HEAD` sees only tracked files, so a brand-new file counts
   * as zero until it is added. In immersive mode that is precisely the
   * common case — starting a project means creating files — and the
   * measurement would have systematically missed the work the mode
   * exists to produce.
   */
  export function worktreeStat(repo: string): { added: number; removed: number } {
    const tracked = sumNumstat(git(["diff", "--numstat", "HEAD"], repo))
    return { added: tracked.added + untrackedLines(repo), removed: tracked.removed }
  }

  /** Work committed between two revisions. */
  export function rangeStat(repo: string, from: string, to: string): { added: number; removed: number } {
    return sumNumstat(git(["diff", "--numstat", `${from}..${to}`], repo))
  }

  export function captureBaseline(cwd: string): GitBaseline | null {
    const repo = repoRoot(cwd)
    if (!repo) return null
    const wt = worktreeStat(repo)
    return { repo, head: headSha(repo), added: wt.added, removed: wt.removed }
  }

  /**
   * Lines written since the baseline.
   *
   * Committing mid-session moves HEAD and resets the working-tree diff, so
   * a naive "diff now minus diff then" would go negative the moment the
   * user commits — which is precisely when they have been most productive.
   * Counting commits since the baseline HEAD *plus* the current working
   * tree, minus what was already dirty at the start, survives that.
   */
  export function linesSinceBaseline(base: GitBaseline): { added: number; removed: number } | null {
    const repo = base.repo
    const nowHead = headSha(repo)
    if (!nowHead) return null

    let added = 0
    let removed = 0

    if (base.head && base.head !== nowHead) {
      const committed = rangeStat(repo, base.head, nowHead)
      added += committed.added
      removed += committed.removed
    }

    const wt = worktreeStat(repo)
    added += wt.added - base.added
    removed += wt.removed - base.removed

    return { added: Math.max(0, added), removed: Math.max(0, removed) }
  }

  export function build(
    state: Immersive.State,
    turns: TurnLike[],
    now: Date,
    endedBy: "manual" | "timebox",
  ): Summary {
    const startMs = Date.parse(state.started_at)
    const inSession = turns.filter((t) => {
      if (!t || typeof t.ts !== "string") return false
      const ts = Date.parse(t.ts)
      return !Number.isNaN(ts) && !Number.isNaN(startMs) && ts >= startMs
    })

    const rungs = inSession
      .map((t) => Number(t.hint_level))
      .filter((n) => Number.isFinite(n))
    const avg_rung =
      rungs.length > 0 ? Math.round((rungs.reduce((a, b) => a + b, 0) / rungs.length) * 10) / 10 : null

    const unlocks = Array.isArray(state.unlocks) ? state.unlocks : []

    const base = (state as unknown as { git_baseline?: GitBaseline | null }).git_baseline ?? null
    const lines = base ? linesSinceBaseline(base) : null

    // Subtract what the agent wrote through scaffold windows. Unlike an
    // unlock — where its work is indistinguishable from the user's in
    // the same tree — the gate saw every scaffolded file and counted it,
    // so here the user's number can actually be theirs.
    const scaffoldLines = Immersive.totalScaffoldLines(state)
    const added = lines ? Math.max(0, lines.added - scaffoldLines) : null

    return {
      started_at: state.started_at,
      ended_at: now.toISOString(),
      duration_minutes: Immersive.elapsedMinutes(state, now),
      ended_by: endedBy,
      lines_added: added,
      lines_removed: lines ? lines.removed : null,
      repo: base ? base.repo : null,
      turns_total: inSession.length,
      turns_user_wrote: inSession.filter((t) => t.user_wrote === true).length,
      avg_rung,
      unlock_count: unlocks.length,
      unlock_minutes: unlocks.reduce((a, u) => a + (Number(u.minutes) || 0), 0),
      unlock_reasons: unlocks.map((u) => String(u.reason ?? "")).filter((s) => s.length > 0),
      scaffold_lines: scaffoldLines,
      scaffold_windows: Immersive.totalScaffoldWindows(state),
    }
  }

  /**
   * Plain numbers, no gamification. No badges, no streak celebration, no
   * "great job" — an honest number the user can act on is the product.
   * This is the same reason the calibration grader defaults to fail.
   */
  export function render(s: Summary): string {
    const lines: string[] = []
    lines.push(`immersive session ended (${s.ended_by === "timebox" ? "timebox elapsed" : "stopped manually"})`)
    lines.push(`duration: ${s.duration_minutes} min`)

    if (s.lines_added !== null && s.lines_removed !== null) {
      lines.push(`you wrote: +${s.lines_added} / -${s.lines_removed} lines`)
    } else {
      lines.push("you wrote: (not measured — the session did not start inside a git repo)")
    }

    if (s.scaffold_windows > 0) {
      lines.push(
        `scaffolded by the agent: +${s.scaffold_lines} lines in ${s.scaffold_windows} window(s) (excluded from the count above)`,
      )
    }

    lines.push(`turns where you produced code: ${s.turns_user_wrote} / ${s.turns_total}`)
    lines.push(
      s.avg_rung === null
        ? "average ladder rung: (no turns recorded)"
        : `average ladder rung: ${s.avg_rung} (lower = you needed less help)`,
    )

    if (s.unlock_count === 0) {
      lines.push("unlocks: 0")
    } else {
      lines.push(`unlocks: ${s.unlock_count} (${s.unlock_minutes} min total) — ${s.unlock_reasons.join("; ")}`)
      // The line count cannot tell an unlocked agent's work from the
      // user's; both land in the same working tree. Saying so is cheaper
      // than a wrong number the user might trust.
      if (s.lines_added !== null) {
        lines.push("note: code the agent wrote during an unlock is included in the line count above.")
      }
    }

    return lines.join("\n")
  }
}
