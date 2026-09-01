/**
 * autonomy-report.ts — how much of the code that landed was the user's.
 *
 * The rest of this plugin measures comprehension: did the user understand
 * what they were shown. That was always a proxy. Levels 2-5 make a harder
 * question answerable — how much of the code that landed did the user
 * actually produce — because while the gate is armed the agent cannot
 * edit, so what appears in the working tree came from their hands.
 *
 * Git is therefore the honest signal here, not model self-report. The
 * soft signals (ladder rung, self-declared user_wrote) are reported
 * alongside it, never in place of it.
 *
 * WHAT CHANGED FROM THE v0.4 VERSION, and why it matters:
 *
 * The old report measured an immersive SESSION, and captured its git
 * baseline once, at activation, in whatever directory the user happened
 * to be in. The first real use exposed the flaw: the user activated the
 * mode in one repo and then went to work in another, and the report
 * honestly said "+0 lines" about a tree nobody had touched.
 *
 * The axis has no activation to hang a baseline on — it is a persistent
 * level, not a session. So baselines are keyed BY REPOSITORY and rolled
 * over BY UTC DAY, and the UserPromptSubmit hook (which receives `cwd`
 * every single turn) refreshes the one for wherever the user actually is.
 * Changing projects mid-day now starts measuring the new project instead
 * of silently reporting on the old one.
 *
 * Every git call is best-effort: outside a repo, or with git missing,
 * the summary degrades to the soft signals rather than failing.
 */

import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

export namespace AutonomyReport {
  export interface GitBaseline {
    repo: string
    head: string | null
    added: number
    removed: number
    /** UTC day this baseline was taken. Rolls over with the budget. */
    date: string
  }

  /** repo root -> baseline. Keyed by repo so switching projects works. */
  export type Baselines = Record<string, GitBaseline>

  export interface Summary {
    date: string
    level: number
    /** null when the work did not happen inside a git repo. */
    lines_added: number | null
    lines_removed: number | null
    repo: string | null
    turns_total: number
    turns_user_wrote: number
    /** Mean ladder rung across the day. Lower = less help needed. */
    avg_rung: number | null
    escape_count: number
    escape_minutes: number
    escape_reasons: string[]
    /** Lines the agent contributed by creating files, within its budget. */
    agent_lines: number
    agent_files: number
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
    // Check the directory before spawning. `cwd` arrives from the hook
    // payload, and a path this process cannot resolve makes uv_spawn fail
    // with a misleading "ENOENT ... 'git'" that reads as "git is not
    // installed". Cheaper and far more legible to return null here.
    if (!cwd || !existsSync(cwd)) return null
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

  export function captureBaseline(cwd: string, day: string): GitBaseline | null {
    const repo = repoRoot(cwd)
    if (!repo) return null
    const wt = worktreeStat(repo)
    return { repo, head: headSha(repo), added: wt.added, removed: wt.removed, date: day }
  }

  /**
   * The baseline for the repo the user is in right now, capturing a fresh
   * one when there is none or the stored one is from a previous day.
   *
   * Returns null when nothing needs writing, so the caller only takes the
   * profile lock on the rare turn that actually changes something — this
   * runs on every prompt.
   *
   * Keying by repo is the fix for the v0.4 bug where the baseline was
   * pinned to whatever directory the mode happened to be switched on in:
   * the user moved to another project and the report measured the tree
   * they had left.
   */
  export function refreshBaseline(
    baselines: Baselines | undefined | null,
    cwd: string,
    day: string,
  ): { repo: string; baseline: GitBaseline } | null {
    const repo = repoRoot(cwd)
    if (!repo) return null
    const existing = baselines?.[repo]
    if (existing && existing.date === day) return null
    const fresh = captureBaseline(cwd, day)
    return fresh ? { repo, baseline: fresh } : null
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

  export interface BuildInput {
    day: string
    level: number
    turns: TurnLike[]
    baseline: GitBaseline | null
    /** Escapes opened today. */
    escapes: Array<{ at: string; reason: string; minutes: number }>
    /** Today's authorship budget, for the agent's own contribution. */
    agentLines: number
    agentFiles: number
  }

  export function build(input: BuildInput): Summary {
    const turns = Array.isArray(input.turns) ? input.turns : []

    const rungs = turns.map((t) => Number(t.hint_level)).filter((n) => Number.isFinite(n))
    const avg_rung =
      rungs.length > 0 ? Math.round((rungs.reduce((a, b) => a + b, 0) / rungs.length) * 10) / 10 : null

    const lines = input.baseline ? linesSinceBaseline(input.baseline) : null

    // Subtract what the agent wrote by creating files. Unlike an escape —
    // where its work is indistinguishable from the user's in the same
    // tree — the gate saw every file it allowed and counted the lines, so
    // here the user's number can actually be theirs.
    const added = lines ? Math.max(0, lines.added - input.agentLines) : null

    const escapes = Array.isArray(input.escapes) ? input.escapes : []

    return {
      date: input.day,
      level: input.level,
      lines_added: added,
      lines_removed: lines ? lines.removed : null,
      repo: input.baseline ? input.baseline.repo : null,
      turns_total: turns.length,
      turns_user_wrote: turns.filter((t) => t.user_wrote === true).length,
      avg_rung,
      escape_count: escapes.length,
      escape_minutes: escapes.reduce((a, u) => a + (Number(u.minutes) || 0), 0),
      escape_reasons: escapes.map((u) => String(u.reason ?? "")).filter((s) => s.length > 0),
      agent_lines: input.agentLines,
      agent_files: input.agentFiles,
    }
  }

  /**
   * Plain numbers, no gamification. No badges, no streak celebration, no
   * "great job" — an honest number the user can act on is the product.
   * This is the same reason the calibration grader defaults to fail.
   */
  export function render(s: Summary): string {
    const lines: string[] = []
    lines.push(`autonomy — ${s.date} (level ${s.level})`)

    // Level 6 is the axis switched off. A "+0 lines" here would be a zero
    // that actually means "not measured", which is precisely the kind of
    // dishonest number this report exists not to produce.
    if (s.level === 6) {
      lines.push("not applicable: the axis is off at level 6, so nothing distinguishes your lines from the agent's.")
      return lines.join("\n")
    }

    if (s.lines_added !== null && s.lines_removed !== null) {
      lines.push(`you wrote: +${s.lines_added} / -${s.lines_removed} lines${s.repo ? ` in ${s.repo}` : ""}`)
    } else {
      lines.push("you wrote: (not measured — no git repo at this location)")
    }

    if (s.agent_files > 0) {
      lines.push(
        `created by the agent: +${s.agent_lines} lines across ${s.agent_files} file(s) (excluded from the count above)`,
      )
    }

    lines.push(`turns where you produced code: ${s.turns_user_wrote} / ${s.turns_total}`)
    lines.push(
      s.avg_rung === null
        ? "average ladder rung: (no turns recorded)"
        : `average ladder rung: ${s.avg_rung} (lower = you needed less help)`,
    )

    if (s.escape_count === 0) {
      lines.push("escapes: 0")
    } else {
      lines.push(`escapes: ${s.escape_count} (${s.escape_minutes} min total) — ${s.escape_reasons.join("; ")}`)
      // The line count cannot tell an escaped agent's work from the
      // user's; both land in the same working tree. Saying so is cheaper
      // than a wrong number the user might trust.
      if (s.lines_added !== null) {
        lines.push("note: code the agent wrote during an escape is included in the line count above.")
      }
    }

    return lines.join("\n")
  }
}
