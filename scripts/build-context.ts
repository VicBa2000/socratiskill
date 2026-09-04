/**
 * build-context.ts — engine of the UserPromptSubmit hook.
 *
 * Reads the hook JSON from stdin, cross-references the user prompt with
 * the persistent pedagogical profile and the detectors, and writes to
 * stdout the "SOCRATIC CONTEXT" block that Claude Code injects into the
 * model context with the prefix "UserPromptSubmit hook success: ...".
 *
 * Design:
 *   - Imports detector.ts and taxonomy.ts as namespaces (single bun
 *     invocation per turn).
 *   - Reads ~/.claude/socratic/profile.json and (if present)
 *     error-map.json.
 *   - Prints a short markdown block with level, role, domain,
 *     detector signals, active antipatterns, and due Leitner cards.
 *   - Fail-open: on any error, writes nothing and exits 0 so the user
 *     is not blocked.
 */

import { Detector } from "./detector"
import { Taxonomy } from "./taxonomy"
import { HintState } from "./hint-state"
import { Antipatterns } from "./antipatterns"
import { Axis } from "./axis-state"
import { Migrate } from "./migrate-profile"
import { AutonomyReport } from "./autonomy-report"
import { readFileSync, existsSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { StateIO } from "./state-io"
import LEVELS_JSON from "../data/levels.json"

interface HookInput {
  session_id?: string
  prompt?: string
  cwd?: string
  hook_event_name?: string
}

interface Profile {
  global_level: number
  comprehension_speed: number
  copy_tendency: number
  streak_days: number
  calibration_completed: boolean
  last_active: string | null
  last_user_message_length?: number
  pending_calibration_change?: {
    direction: "up" | "down"
    from: number
    to: number
    reason: string
    suggested_at: string
    window_end_turn: number
  }
  challenge_next_turn?: boolean
  enabled?: boolean
}

interface FeynmanStateLite {
  topic: string
  started_at: string
  gaps: string[]
}

interface DrillStateLite {
  kind: "analyze" | "build" | "fix"
  file: string | null
  started_at: string
  /** fix drills only: locate must be passed before implement. */
  phase?: "locate" | "implement"
}

/**
 * The unit currently handed to the user, at levels whose handoff is not
 * "none". Minimal on purpose: a name and the acceptance criteria that
 * were stated before any code existed, which is what makes the later
 * review objective rather than a matter of taste.
 *
 * It lives in the session file rather than the profile because a handoff
 * is scoped to a working session — an abandoned unit must not follow the
 * user into tomorrow, the same reasoning that kept FeynmanState out of
 * the profile.
 */
interface HandoffStateLite {
  unit: string
  criteria: string[]
  opened_at: string
}

/**
 * "Pasame la plantilla, yo codifico." A delivery mode, not a level: the
 * agent hands over structure and the user types the bodies. Session-
 * scoped for the same reason as the two above — a mode declared on
 * Tuesday must not still be on come Thursday without being said again.
 */
interface TemplateStateLite {
  started_at: string
  turns: number
}

interface SessionDocLite {
  date: string
  hint_state?: HintState.State
  feynman?: FeynmanStateLite
  drill?: DrillStateLite
  handoff?: HandoffStateLite
  template?: TemplateStateLite
}

interface ErrorMapEntry {
  topic: string
  domain?: string
  fail_count: number
  next_review_at: string | null
}

/** The axis contract, from data. Falls back to the in-code table. */
const LEVEL_TABLE: Axis.LevelTable | null = (() => {
  try {
    return (LEVELS_JSON as { levels?: Axis.LevelTable }).levels ?? null
  } catch {
    return null
  }
})()

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function readProfile(): Profile | null {
  const p = join(stateDir(), "profile.json")
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Profile
  } catch {
    return null
  }
}

function readTodaySession(): SessionDocLite | null {
  const today = new Date().toISOString().slice(0, 10)
  const p = join(stateDir(), "sessions", `${today}.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SessionDocLite
  } catch {
    return null
  }
}

function readErrorMap(): ErrorMapEntry[] {
  const p = join(stateDir(), "error-map.json")
  if (!existsSync(p)) return []
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown
    if (Array.isArray(raw)) return raw as ErrorMapEntry[]
    if (raw && typeof raw === "object") return Object.values(raw as Record<string, ErrorMapEntry>)
    return []
  } catch {
    return []
  }
}

/**
 * A fix drill has two phases and they demand opposite behavior, so the
 * note has to say which one is running. A phase the model can silently
 * skip is a phase that will be silently skipped — and the locate phase
 * IS the drill.
 */
function drillFixNote(drill: DrillStateLite): string {
  if ((drill.phase ?? "locate") === "locate") {
    return (
      `note: FIX DRILL active on ${drill.file}, phase LOCATE. You have stated the change request; the user must now work out WHERE it goes. ` +
      "Do NOT name the function, quote the line, or describe the neighbourhood — that is the whole exercise. " +
      "If they land in the wrong place, do not correct them: ask a narrowing question. " +
      "When their answer holds up, run `drill.ts --advance` (add `--miss` if it took more than one attempt). " +
      "NEVER edit their files to plant a defect. See skills/socratic/rules/drills.md."
    )
  }
  return (
    `note: FIX DRILL active on ${drill.file}, phase IMPLEMENT. They located it; the acceptance criteria are now the contract. ` +
    "Stay out of the way: answer at the current rung, do not volunteer, do not offer to start it off. " +
    "User closes it with /socratiskill:socratic drill done."
  )
}

function dueCards(entries: ErrorMapEntry[]): ErrorMapEntry[] {
  const now = Date.now()
  return entries.filter((e) => {
    if (!e || !e.next_review_at) return false
    const t = Date.parse(e.next_review_at)
    return !Number.isNaN(t) && t <= now
  })
}

function main(): void {
  let raw = ""
  try {
    raw = readFileSync(0, "utf-8")
  } catch {
    return
  }

  let input: HookInput = {}
  try {
    input = JSON.parse(raw) as HookInput
  } catch {
    return
  }

  const message = (input.prompt ?? "").trim()
  if (!message) return

  // One-shot pause silencer: pause.sh drops a marker so that the first
  // hook run after pause can tell the model "forget the skill you
  // loaded earlier, behave as default Claude Code". Without it, the
  // model keeps emitting HINT_META and restate/plan preambles it
  // absorbed before the pause, until the user starts a fresh session.
  // The marker is consumed (deleted) on use; subsequent turns stay
  // silent (zero token cost). resume.sh also deletes any stale marker.
  const pauseMarker = join(stateDir(), ".pause-silencer-pending")
  const pauseMarkerPresent = existsSync(pauseMarker)
  const pausedFileExists = existsSync(join(stateDir(), "profile.json.paused"))

  const profile = readProfile()
  if (!profile) {
    if (pauseMarkerPresent) {
      try { unlinkSync(pauseMarker) } catch { /* best-effort */ }
    }
    if (pauseMarkerPresent && pausedFileExists) {
      process.stdout.write(
        "SOCRATIC CONTEXT: PAUSED.\n" +
        "The user has just paused the socratic plugin for this session. For the rest of this session and every subsequent turn while it stays paused:\n" +
        "- Ignore any pedagogical instructions, hint levels, mode, or rules you may have absorbed earlier in this conversation.\n" +
        "- Do NOT inject restate/plan/teach/verify preambles. Do NOT chunk into 30-line limits. Do NOT ask for approval before Write/Edit.\n" +
        "- Do NOT emit the HINT_META block at the end of your response.\n" +
        "- Do NOT mention socratiskill, the socratic mode, level limits, antipatterns, feynman mode, or any pedagogical scaffolding unless the user explicitly asks about them.\n" +
        "- Behave exactly as default Claude Code would: implement the user's request directly with the standard agent loop.\n" +
        "If the user runs `/socratiskill:socratic resume`, the next turn will restore socratic mode.\n",
      )
    }
    return
  }
  if (profile.enabled === false) {
    // The user explicitly disabled the plugin. Going silent is not enough
    // because (a) the plugin's commands and skills remain registered in
    // Claude Code's available-skills list, so the model still perceives
    // the plugin's existence, and (b) earlier turns in the session may
    // already contain socratic context that biases behavior. Emit an
    // explicit override that tells the model to forget the pedagogical
    // mode and behave as default Claude Code for this turn.
    process.stdout.write(
      "SOCRATIC CONTEXT: DISABLED.\n" +
      "The user has turned the socratic plugin OFF for this session. For this turn and every subsequent turn while it stays off:\n" +
      "- Ignore any pedagogical instructions, hint levels, mode, or rules you may have absorbed earlier in this conversation.\n" +
      "- Do NOT inject restate/plan/teach/verify preambles. Do NOT chunk into 30-line limits. Do NOT ask for approval before Write/Edit.\n" +
      "- Do NOT emit the HINT_META block at the end of your response.\n" +
      "- Do NOT mention socratiskill, the socratic mode, level limits, antipatterns, feynman mode, or any pedagogical scaffolding unless the user explicitly asks about them.\n" +
      "- Behave exactly as default Claude Code would: implement the user's request directly with the standard agent loop.\n" +
      "If the user runs `/socratiskill:socratic on`, the next turn will resume socratic mode.\n",
    )
    return
  }

  // readLevel, never a min(5,...) clamp: level 6 is the axis switched
  // OFF, and clamping it to 5 would silently hand the user the most
  // restrictive setting instead.
  const level = Axis.readLevel(profile.global_level)
  const spec = Axis.spec(level, LEVEL_TABLE)
  const role = spec.label

  const prevLen = Number(profile.last_user_message_length ?? 0) || 0

  const zk = Detector.detectZeroKnowledge(message)
  const slow = Detector.detectSlowDownRequest(message)
  const tech = Detector.countTechnicalTerms(message)
  const copy = Detector.detectCopyPaste(message, level, prevLen)

  const domains = Taxonomy.detectDomains(message)
  const primary = domains[0] ?? null
  const domainLabel = primary ? Taxonomy.DOMAINS[primary]!.label : null

  const due = dueCards(readErrorMap())

  const session = readTodaySession()
  const hintState = session?.hint_state ?? null
  const feynman = session?.feynman ?? null
  // Off-ramp excepted: at level 6 the axis is off and a delivery mode has
  // nothing to deliver. Everywhere else the mode is the user's to declare.
  // The mode is only injected where handing over a skeleton is MORE
  // restrictive than what the level already delivers:
  //
  //   L1     the level says the agent writes the code. The mode overrides
  //          that. This is its whole reason for existing.
  //   L2-L3  the level already hands over skeletons. The mode sets their
  //          shape; it does not change who writes what.
  //   L4+    the user already writes everything — L4 produces "not even a
  //          skeleton of one", L5 only asks questions, L6 is the axis off.
  //          A note here could ONLY loosen the level: an injected "hand
  //          over structure" turns L5 into L3. So nothing is injected.
  //
  // The last case is not hypothetical. The first draft gated this on the
  // off ramp alone, and a user at level 5 with the mode on got a directive
  // reading "this OVERRIDES your level's delivery: hand over structure" —
  // the exact opposite of what level 5 is.
  const TEMPLATE_MAX_LEVEL = 3
  const template = level <= TEMPLATE_MAX_LEVEL ? (session?.template ?? null) : null
  const handoff = session?.handoff ?? null

  const activeAntipatterns = Antipatterns.getActive(Antipatterns.readState())

  const now = new Date()
  const budget = (profile as Record<string, unknown>)["axis_budget"] as Axis.Budget | undefined
  const escapes = (profile as Record<string, unknown>)["escapes"] as Axis.Escape[] | undefined
  const escaped = Axis.isEscapeActive(escapes, now)
  const offRamp = Axis.isOffRamp(level)

  // The gate is armed on 2-5, disarmed at L1 (the agent is meant to
  // write), on the off ramp, and while an escape is open — plus the one
  // exception: template mode arms it at L1 too, borrowing the authorship
  // half of level 3's contract.
  //
  // This mirrors Axis.gateContract deliberately. gate-tool.ts decides;
  // this only DESCRIBES the decision to the model, and the description has
  // to match or the model is denied by a rule its context never mentioned.
  // If you change the borrow rule, change it in both places — S39 asserts
  // they agree.
  const borrowed = template !== null && !escaped && level === Axis.MIN_LEVEL
  const authSpec = borrowed ? Axis.spec(Axis.TEMPLATE_CONTRACT_LEVEL, LEVEL_TABLE) : spec
  const armed = !escaped && !offRamp && authSpec.may_edit_existing === false
  const filesLeft = Axis.remainingFiles(level, budget, now, LEVEL_TABLE)

  // Autonomy baseline for the repo the user is in RIGHT NOW.
  //
  // This is where the v0.4 bug is fixed: the old baseline was captured
  // once, when immersive mode was switched on, in whatever directory
  // that happened to be. A user who then went to work in another project
  // got an honest "+0 lines" about a tree nobody had touched. The hook
  // receives `cwd` every turn, so the baseline follows the user instead.
  //
  // Only takes the lock on the rare turn that actually needs a new one —
  // this runs on every single prompt.
  if (armed && input.cwd) {
    try {
      const day = Axis.dayKey(now)
      const baselines = (profile as Record<string, unknown>)["git_baselines"] as
        | AutonomyReport.Baselines
        | undefined
      const fresh = AutonomyReport.refreshBaseline(baselines, input.cwd, day)
      if (fresh) {
        const profilePath = join(stateDir(), "profile.json")
        StateIO.withLock(`${profilePath}.lock`, () => {
          const cur = existsSync(profilePath)
            ? (JSON.parse(readFileSync(profilePath, "utf-8")) as Record<string, unknown>)
            : ({} as Record<string, unknown>)
          const map = (cur["git_baselines"] as AutonomyReport.Baselines | undefined) ?? {}
          map[fresh.repo] = fresh.baseline
          cur["git_baselines"] = map
          StateIO.writeJsonAtomic(profilePath, cur)
        })
      }
    } catch (e) {
      // Best-effort: a missing measurement must never block a turn.
      if (process.env["SOCRATIC_DEBUG"]) process.stderr.write(`baseline: ${String(e)}\n`)
    }
  }

  // Schema migration, applied on the first turn after an upgrade. Done
  // here rather than in a separate process because this hook already
  // holds the profile every turn, and a migration the user never sees is
  // the failure mode the whole design was built to avoid: old level 5 and
  // new level 5 mean opposite things and both read as "quiet".
  let migrationNotice: string | null = null
  if (Migrate.needsMigration(profile as unknown as Record<string, unknown>)) {
    const profilePath = join(stateDir(), "profile.json")
    try {
      StateIO.withLock(`${profilePath}.lock`, () => {
        const fresh = existsSync(profilePath)
          ? (JSON.parse(readFileSync(profilePath, "utf-8")) as Record<string, unknown>)
          : ({} as Record<string, unknown>)
        const result = Migrate.migrate(fresh, now)
        if (!result.changed) return
        StateIO.writeJsonAtomic(profilePath, result.profile)
        migrationNotice = result.notice
      })
    } catch {
      // fail-open: the next turn retries. Never block the user on a
      // migration.
    }
  }

  const lines: string[] = []
  lines.push("SOCRATIC CONTEXT")
  lines.push(`level: ${level} (${role}) — ${spec.summary}`)

  if (offRamp) {
    lines.push("axis: OFF (level 6). No pedagogy this session.")
  } else if (escaped) {
    lines.push(`escape: OPEN (${Axis.escapeRemainingMinutes(escapes, now)} min left) — write normally, do NOT comment on it.`)
  } else if (armed) {
    lines.push(
      `authorship: you may CREATE new files (${filesLeft === null ? "unlimited" : `${filesLeft} left today`}, ` +
        `max ${authSpec.statements_per_file ?? "unlimited"} executable statement(s) each); you may NOT edit existing ones.` +
        (borrowed
          ? " This is TEMPLATE MODE, not your level — the gate is armed and will DENY a body, even though level 1 would otherwise let you write one."
          : ""),
    )
  }

  const ruleExtras: string[] = []
  // Only where a unit actually changes hands: at L1 and L5 the handoff
  // protocol has nothing to say, and pointing at it would invite the
  // model to invent one.
  if (armed && spec.handoff !== "none") ruleExtras.push("handoff.md")
  if (feynman) ruleExtras.push("feynman.md")
  if (template) ruleExtras.push("template.md")
  if (activeAntipatterns.length > 0) ruleExtras.push("antipatterns.md")
  const rulesSuffix = ruleExtras.length > 0 ? " + " + ruleExtras.join(" + ") : ""
  lines.push(`rules: follow skills/socratic/rules/${spec.rules} + axis.md + ladder.md${rulesSuffix}`)

  if (migrationNotice) {
    lines.push("")
    lines.push("--- ONE-TIME UPGRADE NOTICE (relay this to the user VERBATIM, before anything else) ---")
    lines.push(migrationNotice)
    lines.push("--- end notice ---")
  }

  if (feynman) {
    lines.push(`feynman: teaching "${feynman.topic}" since ${feynman.started_at} (${feynman.gaps.length} gaps logged)`)
  }

  if (template) {
    lines.push(`template: ON since ${template.started_at} (${template.turns} turn(s)) — the user writes the bodies`)
  }

  const drill = session?.drill ?? null
  if (drill) {
    lines.push(
      `drill: ${drill.kind}${drill.file ? ` on ${drill.file}` : ""} since ${drill.started_at}`,
    )
  }

  if (primary) {
    lines.push(`domain: ${primary} (${domainLabel})`)
  } else {
    lines.push("domain: (none detected)")
  }

  if (hintState) {
    const hl = HintState.clampHint(hintState.currentLevel)
    const suffix = hintState.zeroKnowledgeActive ? " [zk-active]" : ""
    lines.push(`hint: ${hl} (${HintState.hintName(hl)})${suffix}`)
  }

  const signals: string[] = []
  if (zk > 0) signals.push(`zero-knowledge=${zk}`)
  if (slow) signals.push("slow-down")
  if (copy.isCopy) signals.push(`copy-paste(conf=${copy.confidence.toFixed(2)})`)
  if (tech >= 2) signals.push(`tech-terms=${tech}`)
  lines.push(`signals: ${signals.length ? signals.join(" ") : "(none)"}`)

  if (activeAntipatterns.length > 0) {
    const summary = activeAntipatterns
      .sort((a, b) => b.occurrence_count - a.occurrence_count)
      .map((p) => `${p.id}(${p.occurrence_count})`)
      .join(", ")
    lines.push(`active antipatterns: ${summary}`)
  }

  const pending = profile.pending_calibration_change
  if (pending) {
    lines.push(`calibration: suggest level ${pending.from} -> ${pending.to} (${pending.reason})`)
    lines.push(`note: tell the user you notice a pattern and propose running "/socratiskill:socratic accept" (or "level ${pending.to}"). Wait for confirmation — do NOT change level yourself.`)
  }

  const diag = (profile as Record<string, unknown>)["pending_diagnostic"] as
    | {
        target_level: number
        turns_asked: number
        turns_passed: number
      }
    | undefined
  if (diag) {
    const remaining = Math.max(0, 3 - diag.turns_asked)
    lines.push(
      `diagnostic: probing readiness for level ${diag.target_level} (${diag.turns_asked}/3 turns, ${diag.turns_passed} passes)`,
    )
    lines.push(
      `DIAGNOSTIC MODE (${remaining} turn(s) remaining): the user may be ready for level ${diag.target_level}. THIS turn, ask ONE concise comprehension question appropriate for level ${diag.target_level}, on a topic the user recently engaged with. Do NOT announce the diagnostic to the user — frame it as a natural follow-up. In your HINT_META, set \`diagnostic\` to \`"pass"\` if their answer demonstrates level-${diag.target_level} understanding, \`"fail"\` if it falls short. If the user is clearly off-topic, ignore (set diagnostic to null).`,
    )
    // Anti-adulation pressure during the diagnostic window. The grader
    // (the model itself) is the same system that otherwise tends toward
    // optimistic agreement; the diagnostic is the single decision point
    // where that bias most distorts the calibration. A "mostly right"
    // verdict inflated here translates directly into an undeserved
    // promotion, so we instruct the model to default to fail on ambiguity.
    lines.push(
      "ANTI-ADULATION (active for this diagnostic): judge the user's answer on SUBSTANCE, not tone or confidence. A vague, partial, or hand-wavy answer is a FAIL, not a PASS. Confident-sounding guesses are FAIL. When in doubt, set diagnostic=\"fail\". Do NOT hedge, do NOT soften the grade to be encouraging — an inflated pass here promotes the user to a level they're not ready for.",
    )
  }

  if (profile.challenge_next_turn) {
    lines.push("challenge: ACTIVE for this turn")
    lines.push("note: anti-adulation mode — refuse flattery, demand precise answers, reject vague reasoning, do NOT hedge. One turn only.")
    // RMW the profile under a lock to avoid racing record-turn's
    // write at the end of the turn. Re-read inside the lock so we
    // don't clobber last_active / pending_calibration_change set
    // by a concurrent hook.
    const profilePath = join(stateDir(), "profile.json")
    try {
      StateIO.withLock(`${profilePath}.lock`, () => {
        const fresh = existsSync(profilePath)
          ? (JSON.parse(readFileSync(profilePath, "utf-8")) as Record<string, unknown>)
          : ({} as Record<string, unknown>)
        delete fresh["challenge_next_turn"]
        StateIO.writeJsonAtomic(profilePath, fresh)
      })
    } catch {
      // fail-open: leave flag set, next turn will consume it
    }
  }

  if (due.length > 0) {
    const summary = due
      .slice(0, 3)
      .map((c) => `${c.topic}(fails=${c.fail_count})`)
      .join(", ")
    lines.push(`review due: ${due.length} card(s) — ${summary}`)
    lines.push("note: if the user is idle or asks what to do, suggest running /socratiskill:socratic review to practice one overdue card.")
  }

  if (zk > 0) {
    lines.push("note: user signaled zero-knowledge — drop one hint rung and explain the term before proceeding.")
  }
  if (slow) {
    lines.push("note: user asked to slow down — pause, summarize, wait for acknowledgment.")
  }
  if (copy.isCopy) {
    lines.push(`note: likely copy-paste — ask the user to explain the snippet before building on it. reasons: ${copy.reasons.join("; ")}`)
  }
  if (feynman) {
    lines.push(
      `note: FEYNMAN MODE — the USER is the teacher of "${feynman.topic}". Do NOT explain, do NOT fill gaps. Probe with concrete examples, edge cases, and "why not X". See skills/socratic/rules/feynman.md. User must run /socratiskill:socratic endteach to exit.`,
    )
  }
  if (template) {
    // Two wordings, because the mode means two different things. At L1 it
    // contradicts the level and has to say so out loud, or the level's own
    // "at this level, yes, write it" wins. At L2-L3 the level ALREADY
    // hands over skeletons, so an "override" framing would be an invitation
    // to give away more than the level allows — there it only sets shape.
    const shared =
      "hand over structure only (real signature, numbered work order in comments, an anchor in their own repo, " +
      "one flagged trap left open, `...` where the body goes) and then STOP. Do not write the body, do not " +
      "transliterate it into comments, do not resolve the trap you flagged. When they come back with code, review " +
      "it against your numbered steps by number and report user_wrote in HINT_META. " +
      "See skills/socratic/rules/template.md. User exits with /socratiskill:socratic template off."
    lines.push(
      level === Axis.MIN_LEVEL
        ? `note: TEMPLATE MODE — the user has asked to write the bodies. This OVERRIDES your level's delivery: ${shared}`
        : `note: TEMPLATE MODE — this does NOT change what your level lets you author; it is the SHAPE of the skeleton you already hand over. Within that: ${shared}`,
    )
  }
  if (drill) {
    lines.push(
      drill.kind === "analyze"
        ? `note: ANALYZE DRILL active on ${drill.file}. Ask ONE question per turn and wait; do not explain the file first. Grade honestly in HINT_META (vague answers are correct:false) and keep the topic slug stable so wrong answers become Leitner cards. See skills/socratic/rules/drills.md. User closes it with /socratiskill:socratic drill done.`
        : drill.kind === "fix"
          ? drillFixNote(drill)
          : "note: BUILD DRILL active. The acceptance criteria agreed at the start are the contract. Stay out of the way: answer at the current rung, do not volunteer, do not offer to start it off. See skills/socratic/rules/drills.md. User closes it with /socratiskill:socratic drill done.",
    )
  }
  if (activeAntipatterns.length > 0) {
    const ids = activeAntipatterns.map((p) => p.id).join(", ")
    lines.push(
      `note: ACTIVE ANTIPATTERNS (${ids}) — before emitting code, check if the snippet would introduce any of these. If yes, rewrite first and explain why. If the user's code contains one, call it out before building on top. See skills/socratic/rules/antipatterns.md.`,
    )
  }

  // Per-level protocol reinforcement. The rule files describe the
  // expected behavior, but soft sentences in markdown don't survive the
  // pull of the system prompt's "be helpful, complete tasks". A short,
  // imperative, capitalized block injected at the END of the SOCRATIC
  // CONTEXT (just before the META PROTOCOL) sits closest to the model's
  // generation step and reliably triggers the protocol that was observed
  // to fail without it.
  //
  // ONE axis now: the block is chosen by level and nothing else. There is
  // no mode to cross it with and no separate authorship branch, because
  // "who writes the code" IS the level.
  const rungLevel = Axis.clampRung(
    level,
    hintState
      ? HintState.clampHint(hintState.currentLevel)
      : HintState.getInitialHintLevel(HintState.clampUserLevel(Axis.clampToAxis(level))),
    LEVEL_TABLE,
  )
  const rung = Axis.rung(rungLevel)

  if (escaped) {
    lines.push("")
    lines.push("--- ESCAPE OPEN (overrides the level protocol) ---")
    lines.push("The user deliberately bought an escape hatch and logged a reason. Write code normally this turn.")
    lines.push("Do NOT moralize about it. No \"¿estás seguro?\", no reminder about their goals, no visible disappointment, no \"está bien, pero...\". The log is the accountability; your commentary is not.")
    lines.push("The level protocol resumes by itself when the window elapses. Do not announce that either.")
  } else if (offRamp) {
    // Level 6 is the axis switched off. No protocol block at all: any
    // pedagogical instruction here would contradict what the user asked
    // for by typing `level 6`.
    lines.push("")
    lines.push("--- LEVEL 6 (axis off) ---")
    lines.push("Work as a normal code assistant. Write code freely. Do NOT ask pedagogical questions, do NOT teach, do NOT verify comprehension.")
    lines.push("Intervene only for a real problem: security vulnerability, likely bug, serious anti-pattern, or a significantly better alternative — one sentence, ending in \"¿Intencional?\". Do not insist.")
    lines.push("Do NOT comment on the fact that the user is at level 6, and do NOT suggest they move.")
  } else if (level === 1) {
    lines.push("")
    lines.push("--- LEVEL 1 HARD LIMITS (critical, not optional) ---")
    lines.push("You write the code at this level — but every line has to teach, or this is level 6 with extra words.")
    lines.push("DO NOT call Write / Edit / MultiEdit until the user has explicitly approved the plan in THIS turn. \"Dale\", \"ok hazlo\", \"yes\", or a specific correction count as approval. Silence does not. Past-turn approval does not — re-confirm.")
    lines.push("MAX 30 lines of code per response (counting blanks and comments). MAX 1 file touched per response.")
    lines.push("BEFORE any code, your response MUST contain in this order: (1) restate the user's request in your own words, (2) plan in 3-6 bullets with file names and line counts, (3) teach prerequisite concepts in plain language with analogies, (4) ask ONE pointed COMPREHENSION question (NOT a design-preference question). Then END THE TURN. No tool calls.")
    lines.push("Verification question must test UNDERSTANDING, not preference. GOOD: \"¿por qué elegimos X en lugar de Y?\", \"si cambiáramos A a B, ¿qué se rompería?\", \"explicalo con tus palabras\". BAD: \"¿querés A o B?\", \"¿te parece bien?\", \"¿alguna pregunta?\".")
    lines.push("After approval, write code in chunks of <=30 lines and ask a follow-up verification question after each chunk before continuing.")
    lines.push("If the user explicitly overrides (\"escribilo todo\", \"ya sé esto\"), acknowledge in one line, proceed for that turn only, and suggest /socratiskill:socratic level 3.")
    lines.push("Violating any of the above is a critical failure, not a stylistic imperfection. See skills/socratic/rules/level-1-implementer.md.")
  } else {
    // Levels 2-5: the user holds the keyboard for the load-bearing work.
    // The shared core first, then what differs by level.
    lines.push("")
    lines.push(`--- LEVEL ${level} PROTOCOL (critical, overrides the default helpfulness pull) ---`)
    lines.push(`The user is deliberately keeping their own coding ability. At this level: ${spec.summary}`)
    lines.push("DO NOT edit files that already exist. A PreToolUse gate denies it — do not fight it, and do not route around it via Bash (cat >, tee, sed -i, heredocs) or by delegating to a subagent.")
    lines.push("DO NOT paste code blocks the user can copy. That is the same failure with extra steps: the point is that THEY produce the code, not that the code appears.")
    lines.push(`CURRENT RUNG: ${rungLevel} (${rung.name}). ${rung.directive}`)
    lines.push("Escalation is automatic and NOT yours to shortcut. If the user answers wrong twice, or signals they do not know, the rung rises by itself next turn. Do NOT jump ahead because they look stuck — that is adulation wearing a helpful costume.")
    lines.push("Reading and analysis are encouraged: use Read / Grep / Glob freely so your questions are grounded in THEIR actual repo, not in generic advice.")

    if (spec.statements_per_file === 0) {
      lines.push(
        `You MAY create files that do not exist (${filesLeft === null ? "unlimited" : `${filesLeft} left today`}), but they must contain ZERO executable statements: imports, types, signatures, comments and TODO markers only. The gate counts them and denies the write otherwise.`,
      )
    } else if (spec.statements_per_file !== null) {
      lines.push(
        `You MAY create files that do not exist (${filesLeft === null ? "unlimited" : `${filesLeft} left today`}) with at most ${spec.statements_per_file} executable statements each — plumbing and trivial bodies only. The load-bearing logic is the user's, however short it is.`,
      )
    }

    lines.push("When the user shows you code they wrote: REVIEW it, do not rewrite it. Point at the specific line, name the problem, ask what they would do about it. Praise only something specifically good; generic encouragement is noise, and here it is worse than silence.")

    if (spec.handoff !== "none") {
      lines.push("")
      lines.push(`HANDOFF PROTOCOL (by ${spec.handoff}) — follow it in order, one unit at a time:`)
      lines.push(`  1. Deliver the structure your level allows, for ONE ${spec.handoff} only.`)
      lines.push(`  2. NAME the unit you are handing over, explicitly and by name.`)
      lines.push("  3. STATE ACCEPTANCE CRITERIA before any code exists. This is what makes the later review objective instead of a matter of taste — without it you will end up arguing about style.")
      lines.push("  4. STOP. End the turn. Do not start the next unit, and do not fill the silence.")
      lines.push("  5. When they come back, review against the criteria from step 3, then move to the next unit.")
      lines.push("Do NOT frame the whole feature and walk away — one unit, then wait.")
    } else {
      lines.push("You do NOT direct the work at this level. No decomposition, no ordered plans, no naming the next step — those are lower-level moves. Ask.")
    }

    if (handoff) {
      lines.push("")
      lines.push(`UNIT IN FLIGHT: "${handoff.unit}" (handed over ${handoff.opened_at}).`)
      if (Array.isArray(handoff.criteria) && handoff.criteria.length > 0) {
        lines.push(`Acceptance criteria you already stated: ${handoff.criteria.join(" | ")}`)
      }
      lines.push("Do NOT hand over another unit until this one is reviewed and closed. If the user's message is that implementation, review it against those criteria and close the unit in HINT_META.")
    }
  }

  lines.push("")
  lines.push("--- META PROTOCOL (required) ---")
  lines.push("At the END of your response, emit the HINT_META block as an HTML comment on its own line. HTML comments are invisible in the rendered markdown output, so the user does not see the telemetry:")
  lines.push('<!-- HINT_META {"topic":"<slug>","correct":<true|false|null>,"domain":"<key>","hintLevel":<0-5>} /HINT_META -->')
  lines.push("Do NOT use the legacy bracket form `[HINT_META]...[/HINT_META]` — it renders as visible text.")
  lines.push("Fields:")
  lines.push("  topic      short slug of the main concept discussed (e.g., closure, promise, useState). null if none.")
  lines.push("  correct    true if the user demonstrated understanding in THIS turn, false if they were confused or made a mistake, null if not applicable (general question, coding task with no evaluation).")
  lines.push("  domain     one of: fundamentos | lenguajes | paradigmas | web | backend | infraestructura | avanzado. null if none.")
  if (armed) {
    // "Full scaffolding" would read as an invitation to hand over code,
    // which is exactly what the ceiling forbids above level 1. Name the
    // real ceiling instead.
    lines.push("  hintLevel  0-5, the ladder rung you actually used. 0 = pure socratic (questions only). 5 = full work order (spec, never code). Reflect how much you gave away THIS turn.")
  } else {
    lines.push("  hintLevel  0-5. 0 = pure socratic (questions only). 5 = full scaffolding. Reflect how direct THIS answer was.")
  }
  lines.push(`  readiness  (optional) "above" | "at" | "below" | null. Your judgment of whether the user's answer operated above, at, or below their current level ${level}. "above" means the user showed dominance beyond what level ${level} requires; "below" means they struggled with a level-${level} concept. null if unclear or not applicable.`)
  if (feynman) {
    lines.push('  feynman_gap  (REQUIRED while feynman mode is active) short phrase describing a gap revealed by the user this turn, or null if the explanation was solid. Example: "confuses then() with await".')
  }
  if (diag) {
    lines.push(`  diagnostic  (REQUIRED this turn — diagnostic mode is active) "pass" | "fail" | null. pass = the user's answer demonstrated level-${diag.target_level} understanding; fail = it did not; null = off-topic / not applicable this turn.`)
  }
  if (armed || template) {
    // Asked whenever the user is the one expected to produce code. Before
    // template existed this was gated on `armed` alone, which excluded
    // level 1 — so a user who typed every line of a project while sitting
    // at level 1 left behind a run of turns all recording user_wrote:null.
    // The one field that measures what the axis is FOR was absent exactly
    // where the user had opted into doing the work.
    lines.push(
      '  user_wrote  (REQUIRED at this level) true | false | null. true if the USER produced or modified code this turn (pasted it, described what they wrote, or said they implemented it); false if the turn passed with no code produced by them; null if not applicable (planning, questions, analysis).',
    )
  }
  if (armed && spec.handoff !== "none") {
    // What carries a handoff across turns. Without it the next turn
    // cannot tell whether the agent is still waiting on the user, and the
    // protocol silently degrades into "frame everything, then chat".
    lines.push(
      '  handoff    (REQUIRED at this level) {"unit":"<name>","criteria":["<criterion>",...]} when you hand a unit over THIS turn; the string "close" when the unit in flight has been reviewed and accepted; null when nothing changed hands.',
    )
  }
  lines.push("The block is for telemetry only — the user does not read it. Keep valid JSON.")

  process.stdout.write(lines.join("\n") + "\n")
}

main()
