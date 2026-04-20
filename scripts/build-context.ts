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
 *   - Prints a short markdown block with level, mode, role, domain,
 *     detector signals, active antipatterns, and due Leitner cards.
 *   - Fail-open: on any error, writes nothing and exits 0 so the user
 *     is not blocked.
 */

import { Detector } from "./detector"
import { Taxonomy } from "./taxonomy"
import { HintState } from "./hint-state"
import { Antipatterns } from "./antipatterns"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { StateIO } from "./state-io"
import ROLES_JSON from "../data/roles.json"

interface HookInput {
  session_id?: string
  prompt?: string
  cwd?: string
  hook_event_name?: string
}

interface Profile {
  global_level: number
  mode: "learn" | "productive"
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

interface SessionDocLite {
  date: string
  hint_state?: HintState.State
  feynman?: FeynmanStateLite
}

interface ErrorMapEntry {
  topic: string
  domain?: string
  fail_count: number
  next_review_at: string | null
}

const ROLES: Record<number, string> = (() => {
  const out: Record<number, string> = {}
  for (const [k, v] of Object.entries(ROLES_JSON as Record<string, unknown>)) {
    if (k.startsWith("_")) continue
    const n = Number(k)
    if (!Number.isNaN(n) && typeof v === "string") out[n] = v
  }
  return out
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

  const profile = readProfile()
  if (!profile) return
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

  const level = Math.min(5, Math.max(1, Number(profile.global_level) || 3))
  const mode = profile.mode === "productive" ? "productive" : "learn"
  const role = ROLES[level] ?? "Pair programmer"

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

  const activeAntipatterns = Antipatterns.getActive(Antipatterns.readState())

  const lines: string[] = []
  lines.push("SOCRATIC CONTEXT")
  lines.push(`level: ${level} (${role})`)
  lines.push(`mode: ${mode}`)
  const ruleExtras: string[] = []
  if (feynman) ruleExtras.push("feynman.md")
  if (activeAntipatterns.length > 0) ruleExtras.push("antipatterns.md")
  const rulesSuffix = ruleExtras.length > 0 ? " + " + ruleExtras.join(" + ") : ""
  lines.push(`rules: follow skills/socratic/rules/level-${level}-*.md + mode-${mode}.md + hint-ladder.md${rulesSuffix}`)

  if (feynman) {
    lines.push(`feynman: teaching "${feynman.topic}" since ${feynman.started_at} (${feynman.gaps.length} gaps logged)`)
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
  if (activeAntipatterns.length > 0) {
    const ids = activeAntipatterns.map((p) => p.id).join(", ")
    lines.push(
      `note: ACTIVE ANTIPATTERNS (${ids}) — before emitting code, check if the snippet would introduce any of these. If yes, rewrite first and explain why. If the user's code contains one, call it out before building on top. See skills/socratic/rules/antipatterns.md.`,
    )
  }

  // Level 1 hard-limit reinforcement. The rule files describe the
  // expected behavior, but soft sentences in markdown don't survive the
  // pull of the system prompt's "be helpful, complete tasks". A short,
  // imperative, capitalized block injected at the END of the SOCRATIC
  // CONTEXT (just before the META PROTOCOL) sits closest to the model's
  // generation step and reliably triggers the chunked / ask-first
  // protocol observed empirically to fail without it.
  if (level === 1) {
    lines.push("")
    lines.push("--- LEVEL 1 HARD LIMITS (critical, not optional) ---")
    lines.push("DO NOT call Write / Edit / MultiEdit until the user has explicitly approved the plan in THIS turn. \"Dale\", \"ok hazlo\", \"yes\", or a specific correction count as approval. Silence does not. Past-turn approval does not — re-confirm.")
    lines.push("MAX 30 lines of code per response (counting blanks and comments). MAX 1 file touched per response.")
    lines.push("BEFORE any code, your response MUST contain in this order: (1) restate the user's request in your own words, (2) plan in 3-6 bullets with file names and line counts, (3) teach prerequisite concepts in plain language with analogies, (4) ask ONE pointed COMPREHENSION question (NOT a design-preference question). Then END THE TURN. No tool calls.")
    lines.push("Verification question must test UNDERSTANDING, not preference. GOOD: \"¿por qué elegimos X en lugar de Y?\", \"si cambiáramos A a B, ¿qué se rompería?\", \"explicalo con tus palabras\". BAD: \"¿querés A o B?\", \"¿te parece bien?\", \"¿alguna pregunta?\". Design-preference questions are level 3 territory; at level 1 the user is in the student seat, not the architect seat.")
    lines.push("After approval, write code in chunks of <=30 lines and ask a follow-up verification question after each chunk before continuing.")
    lines.push("If the user explicitly overrides (\"escribilo todo\", \"ya sé esto\"), acknowledge in one line, proceed for that turn only, and tell them this bypasses level 1 — suggest /socratiskill:socratic level 3.")
    lines.push("Violating any of the above is a critical failure of the socratic mode, not a stylistic imperfection. See skills/socratic/rules/level-1-teacher.md for examples of GOOD vs BAD turns.")
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
  lines.push("  hintLevel  0-5. 0 = pure socratic (questions only). 5 = full scaffolding. Reflect how direct THIS answer was.")
  if (feynman) {
    lines.push('  feynman_gap  (REQUIRED while feynman mode is active) short phrase describing a gap revealed by the user this turn, or null if the explanation was solid. Example: "confuses then() with await".')
  }
  lines.push("The block is for telemetry only — the user does not read it. Keep valid JSON.")

  process.stdout.write(lines.join("\n") + "\n")
}

main()
