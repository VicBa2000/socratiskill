/**
 * record-turn.ts — motor del hook Stop.
 *
 * Al terminar el turno, Claude Code dispara el hook Stop con un JSON que
 * incluye `session_id` y `transcript_path`. Este script:
 *
 *   1. Lee el transcript (JSONL) y busca el ultimo mensaje del assistant
 *      mas el ultimo mensaje del user.
 *   2. Extrae del output del modelo un bloque opcional:
 *        [HINT_META]
 *        {"topic":"useState","correct":false,"domain":"web","hintLevel":2}
 *        [/HINT_META]
 *   3. Arma un TurnRecord y lo appendea a sessions/<YYYY-MM-DD>.json.
 *   4. Si HINT_META trae `correct=false`, incrementa fail_count en
 *      error-map.json y programa next_review_at = +1d (Leitner inicial).
 *      Si `correct=true`, incrementa success_count y, tras 2 correctos
 *      consecutivos, marca resolved=true y reprograma con el siguiente
 *      intervalo Leitner.
 *   5. Fail-open: cualquier excepcion termina con exit 0 sin efectos.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { HintState } from "./hint-state"
import { Detector } from "./detector"
import { Antipatterns } from "./antipatterns"
import { StateIO } from "./state-io"
import ALGORITHM_JSON from "../data/algorithm.json"

interface HookInput {
  session_id?: string
  transcript_path?: string
  hook_event_name?: string
}

interface HintMeta {
  topic?: string
  correct?: boolean
  domain?: string
  hintLevel?: number
  accompanied?: boolean
  reason?: string
  feynman_gap?: string | null
}

interface FeynmanState {
  topic: string
  started_at: string
  gaps: string[]
}

interface FeynmanSummary {
  topic: string
  started_at: string
  ended_at: string
  duration_minutes: number
  gap_count: number
  gaps: string[]
}

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
  accompanied: boolean
  reason: string | null
}

interface ErrorMapEntry {
  topic: string
  domain: string | null
  fail_count: number
  success_count: number
  consecutive_correct: number
  last_hint_level: number
  resolved: boolean
  leitner_box: number
  last_seen: string
  next_review_at: string | null
}

const ALGO = ALGORITHM_JSON as {
  leitner_days: number[]
  calibration_window: number
  calibration_threshold: number
}
const LEITNER_DAYS: number[] = ALGO.leitner_days ?? [1, 3, 7, 14, 30]
const CALIBRATION_WINDOW: number = ALGO.calibration_window ?? 5
const CALIBRATION_THRESHOLD: number = ALGO.calibration_threshold ?? 3

interface SessionDoc {
  date: string
  turns: TurnRecord[]
  hint_state?: HintState.State
  last_calibration_eval_turn?: number
  feynman?: FeynmanState
  feynman_summaries?: FeynmanSummary[]
}

interface PendingCalibration {
  direction: "up" | "down"
  from: number
  to: number
  reason: string
  suggested_at: string
  window_end_turn: number
}

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path))
  StateIO.writeJsonAtomic(path, data)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 3) + "..."
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c
        if (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string") {
          return (c as { text: string }).text
        }
        return ""
      })
      .join("\n")
  }
  if (content && typeof content === "object" && "text" in content) {
    const t = (content as { text: unknown }).text
    if (typeof t === "string") return t
  }
  return ""
}

function parseTranscript(path: string): { userText: string; agentText: string } {
  if (!existsSync(path)) return { userText: "", agentText: "" }
  let raw = ""
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return { userText: "", agentText: "" }
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
  let userText = ""
  let agentText = ""
  for (const line of lines) {
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!obj || typeof obj !== "object") continue
    const o = obj as Record<string, unknown>

    if (o["isMeta"] === true) continue

    const type = o["type"] as string | undefined
    if (type !== "user" && type !== "assistant") continue

    const msg = o["message"] as Record<string, unknown> | undefined
    const content = msg?.["content"] ?? o["content"]
    if (content === undefined) continue

    const text = extractText(content).trim()
    if (!text) continue

    if (type === "user") userText = text
    else agentText = text
  }
  return { userText, agentText }
}

function extractHintMeta(agentText: string): HintMeta | null {
  // Prefer the HTML-comment form (invisible to user); accept the legacy
  // bracket form for turns recorded before the syntax change.
  const commentMatch = agentText.match(/<!--\s*HINT_META\s+([\s\S]*?)\s*\/HINT_META\s*-->/)
  const bracketMatch = commentMatch ? null : agentText.match(/\[HINT_META\]([\s\S]*?)\[\/HINT_META\]/)
  const match = commentMatch ?? bracketMatch
  if (!match) return null
  const body = match[1]!.trim()
  // Validate that the parsed JSON is at least shaped like HintMeta (has
  // one recognizable field). This rejects both malformed JSON and
  // shape-wrong payloads that would otherwise propagate `undefined`
  // fields into turn records and the calibration pipeline.
  return StateIO.parseJson<HintMeta | null>(body, StateIO.isHintMeta as StateIO.Guard<HintMeta>, null)
}

function loadProfile(): { level: number; mode: string } {
  const p = join(stateDir(), "profile.json")
  const data = readJson<Record<string, unknown>>(p, {})
  const level = Math.min(5, Math.max(1, Number(data["global_level"]) || 3))
  const mode = data["mode"] === "productive" ? "productive" : "learn"
  return { level, mode }
}

function loadSessionDoc(): SessionDoc {
  const p = join(stateDir(), "sessions", `${todayIso()}.json`)
  return readJson<SessionDoc>(p, { date: todayIso(), turns: [] })
}

function writeSessionDoc(doc: SessionDoc): void {
  const p = join(stateDir(), "sessions", `${todayIso()}.json`)
  writeJson(p, doc)
}

function evaluateCalibration(
  doc: SessionDoc,
  userLevel: number,
  currentTurn: number,
): PendingCalibration | null {
  const last = doc.last_calibration_eval_turn
  if (typeof last === "number" && currentTurn - last < CALIBRATION_WINDOW) return null

  const window = doc.turns
    .slice(-CALIBRATION_WINDOW)
    .filter((t) => t.correct === true || t.correct === false)
  if (window.length < CALIBRATION_THRESHOLD) return null

  const correctCount = window.filter((t) => t.correct === true).length
  const wrongCount = window.length - correctCount

  let direction: "up" | "down" | null = null
  if (correctCount >= CALIBRATION_THRESHOLD && userLevel < 5) direction = "up"
  else if (wrongCount >= CALIBRATION_THRESHOLD && userLevel > 1) direction = "down"
  if (!direction) return null

  return {
    direction,
    from: userLevel,
    to: direction === "up" ? userLevel + 1 : userLevel - 1,
    reason: `${correctCount}/${window.length} correct in last window of ${window.length}`,
    suggested_at: new Date().toISOString(),
    window_end_turn: currentTurn,
  }
}

function updateErrorMap(meta: HintMeta): void {
  if (!meta.topic) return
  const p = join(stateDir(), "error-map.json")
  const map = readJson<Record<string, ErrorMapEntry>>(p, {})
  const key = `${meta.topic}::${meta.domain ?? "unknown"}`
  const now = new Date()
  const entry: ErrorMapEntry = map[key] ?? {
    topic: meta.topic,
    domain: meta.domain ?? null,
    fail_count: 0,
    success_count: 0,
    consecutive_correct: 0,
    last_hint_level: 0,
    resolved: false,
    leitner_box: 0,
    last_seen: now.toISOString(),
    next_review_at: null,
  }

  entry.last_seen = now.toISOString()
  entry.last_hint_level = Number(meta.hintLevel ?? entry.last_hint_level) || 0

  if (meta.correct === true) {
    entry.success_count += 1
    entry.consecutive_correct += 1
    if (entry.consecutive_correct >= 2) {
      entry.leitner_box = Math.min(LEITNER_DAYS.length - 1, entry.leitner_box + 1)
      const days = LEITNER_DAYS[entry.leitner_box]!
      const next = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
      entry.next_review_at = next.toISOString()
      if (entry.leitner_box >= LEITNER_DAYS.length - 1) entry.resolved = true
    }
  } else if (meta.correct === false) {
    entry.fail_count += 1
    entry.consecutive_correct = 0
    entry.resolved = false
    entry.leitner_box = 0
    const next = new Date(now.getTime() + LEITNER_DAYS[0]! * 24 * 60 * 60 * 1000)
    entry.next_review_at = next.toISOString()
  }

  map[key] = entry
  writeJson(p, map)
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

  // Skill-level kill switch: if profile.enabled is explicitly false, skip all
  // post-turn bookkeeping. Default is enabled (field absent = true).
  const earlyProfile = readJson<Record<string, unknown>>(join(stateDir(), "profile.json"), {})
  if (earlyProfile["enabled"] === false) return

  const sessionId = input.session_id ?? "unknown"
  const transcriptPath = input.transcript_path ?? ""
  const { userText, agentText } = parseTranscript(transcriptPath)
  if (!userText && !agentText) return

  const meta = extractHintMeta(agentText)
  const cleanedAgent = agentText
    .replace(/<!--\s*HINT_META[\s\S]*?\/HINT_META\s*-->/g, "")
    .replace(/\[HINT_META\][\s\S]*?\[\/HINT_META\]/g, "")
    .trim()
  const { level } = loadProfile()

  const record: TurnRecord = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    turn_index: -1,
    topic: meta?.topic ?? null,
    correct: typeof meta?.correct === "boolean" ? meta.correct : null,
    hint_level: Number(meta?.hintLevel ?? 0) || 0,
    user_level: level,
    domain: meta?.domain ?? null,
    user_excerpt: userText ? truncate(userText, 200) : null,
    agent_excerpt: cleanedAgent ? truncate(cleanedAgent, 200) : null,
    accompanied: Boolean(meta?.accompanied),
    reason: meta?.reason ?? null,
  }

  const doc = loadSessionDoc()
  record.turn_index = doc.turns.length
  doc.turns.push(record)

  if (doc.feynman && meta && typeof meta.feynman_gap === "string") {
    const gap = meta.feynman_gap.trim()
    const lower = gap.toLowerCase()
    if (gap.length > 0 && lower !== "null" && lower !== "none") {
      doc.feynman.gaps.push(gap)
    }
  }

  if (!doc.hint_state) {
    doc.hint_state = HintState.createInitialState(HintState.clampUserLevel(level))
  }

  const zk = userText ? Detector.detectZeroKnowledge(userText) > 0 : false
  if (zk) {
    doc.hint_state = HintState.processResponse(doc.hint_state, false, true)
  } else if (record.correct === true || record.correct === false) {
    doc.hint_state = HintState.processResponse(doc.hint_state, record.correct, false)
  }

  const pending = evaluateCalibration(doc, level, record.turn_index)
  if (pending) doc.last_calibration_eval_turn = record.turn_index

  writeSessionDoc(doc)
  if (meta) updateErrorMap(meta)
  Antipatterns.recordTurn(userText, agentText, new Date())

  const profilePath = join(stateDir(), "profile.json")
  // Serialize profile read-modify-write against build-context (clears
  // challenge_next_turn) and accept-calibration (applies level change).
  // Without the lock, concurrent hooks lose each other's writes.
  StateIO.withLock(`${profilePath}.lock`, () => {
    const profile = readJson<Record<string, unknown>>(profilePath, {})
    profile["last_active"] = new Date().toISOString()
    profile["last_user_message_length"] = userText.length
    if (pending) profile["pending_calibration_change"] = pending
    writeJson(profilePath, profile)
  })
}

if (process.env["SOCRATIC_DEBUG"]) {
  main()
} else {
  try {
    main()
  } catch {
    // fail-open in production
  }
}
