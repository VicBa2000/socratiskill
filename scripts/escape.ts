/**
 * escape.ts — `ship <reason> [minutes]`.
 *
 * The deduplication of v0.4's two escape valves. `unlock` (temporary,
 * reason required, logged) and `mode: productive` (persistent, silent)
 * were asking the same question — "I need to ship right now, get out of
 * the way" — and only differed because they had been invented for
 * different axes. Having both meant the user had to know which one their
 * situation was, which is exactly the switch proliferation the axis
 * unification exists to end.
 *
 * What survives from `unlock`: a mandatory reason, an expiry, a log, and
 * honesty in the autonomy report (lines written during an escape cannot
 * be attributed, so the report says so rather than implying a clean
 * number). What survives from `productive`: while it is open the agent
 * actually produces, with no pedagogical overhead.
 *
 * NEVER EDITORIALIZE when the user opens one. No "are you sure", no
 * reminder about their goals, no visible disappointment. Real work has
 * real deadlines, and a lock with no exit gets the plugin uninstalled the
 * first Friday it gets in the way. The log is the accountability; the
 * model's commentary is not. Flattery and scolding are the same error of
 * not respecting the user's decision.
 *
 * Exit codes: 0 ok, 2 bad arguments, 3 no profile / paused.
 */

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Axis } from "./axis-state"
import { StateIO } from "./state-io"

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function profilePath(): string {
  return join(stateDir(), "profile.json")
}

function readProfile(): Record<string, unknown> | null {
  const p = profilePath()
  if (!existsSync(p)) return null
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

interface Args {
  reason: string
  minutes: number
  status: boolean
  end: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { reason: "", minutes: Axis.DEFAULT_ESCAPE_MINUTES, status: false, end: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--status") { out.status = true; continue }
    if (a === "--end") { out.end = true; continue }
    if (a === "--minutes") { out.minutes = Number(argv[++i]) || out.minutes; continue }
    if (a === "--reason") { out.reason = String(argv[++i] ?? ""); continue }
    rest.push(a)
  }
  // Bare form: `ship 20 fixing prod` or `ship fixing prod`.
  if (!out.reason && rest.length > 0) {
    if (/^\d+$/.test(rest[0]!)) {
      out.minutes = Number(rest[0])
      out.reason = rest.slice(1).join(" ")
    } else {
      out.reason = rest.join(" ")
    }
  }
  return out
}

function cmdStatus(): void {
  const profile = readProfile()
  if (!profile) {
    process.stderr.write("no profile found; run /socratiskill:socratic calibrate first\n")
    process.exit(3)
  }
  const escapes = (profile["escapes"] as Axis.Escape[] | undefined) ?? []
  const now = new Date()
  if (!Axis.isEscapeActive(escapes, now)) {
    process.stdout.write(`no escape open. ${escapes.length} logged so far.\n`)
    return
  }
  const last = escapes[escapes.length - 1]!
  process.stdout.write(
    `escape open: ${Axis.escapeRemainingMinutes(escapes, now)} min left\n` +
      `reason: ${last.reason}\n` +
      `${escapes.length} logged so far.\n`,
  )
}

function cmdEnd(): void {
  const p = profilePath()
  if (!readProfile()) {
    process.stderr.write("no profile found\n")
    process.exit(3)
  }
  let wasOpen = false
  StateIO.withLock(`${p}.lock`, () => {
    const fresh = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>
    const escapes = (fresh["escapes"] as Axis.Escape[] | undefined) ?? []
    if (!Axis.isEscapeActive(escapes, new Date())) return
    wasOpen = true
    // Truncate the open escape to what was actually used, so the log
    // reflects reality rather than the window that was asked for.
    const last = escapes[escapes.length - 1]!
    const usedMs = Date.now() - Date.parse(last.at)
    last.minutes = Math.max(1, Math.ceil(usedMs / 60_000))
    fresh["escapes"] = escapes
    StateIO.writeJsonAtomic(p, fresh)
  })
  process.stdout.write(wasOpen ? "escape closed early\n" : "no escape was open\n")
}

function cmdOpen(args: Args): void {
  const profile = readProfile()
  if (!profile) {
    process.stderr.write("no profile found; run /socratiskill:socratic calibrate first\n")
    process.exit(3)
  }
  if (!args.reason.trim()) {
    // The reason is the whole accountability mechanism. Without it the
    // escape is just a switch, and a switch with no record is how the
    // autonomy number quietly stops meaning anything.
    process.stderr.write('error: a reason is required — ship "<why>" [minutes]\n')
    process.exit(2)
  }

  const level = Axis.readLevel(profile["global_level"])
  if (Axis.isOffRamp(level)) {
    process.stderr.write("nothing to escape from: the axis is already off at level 6\n")
    process.exit(2)
  }
  if (level === Axis.MIN_LEVEL) {
    process.stderr.write("nothing to escape from: at level 1 the agent already writes the code\n")
    process.exit(2)
  }

  const minutes = Math.max(1, Math.round(args.minutes))
  const p = profilePath()
  StateIO.withLock(`${p}.lock`, () => {
    const fresh = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>
    const escapes = (fresh["escapes"] as Axis.Escape[] | undefined) ?? []
    escapes.push(Axis.createEscape(new Date(), args.reason.trim(), minutes))
    fresh["escapes"] = escapes
    StateIO.writeJsonAtomic(p, fresh)
  })

  process.stdout.write(
    `escape open for ${minutes} min. The agent writes normally until it expires; it re-arms on its own.\n` +
      `logged: ${args.reason.trim()}\n`,
  )
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.status) return cmdStatus()
  if (args.end) return cmdEnd()
  return cmdOpen(args)
}

main()
