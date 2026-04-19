/**
 * start-teach.ts — CLI del subcomando teach.
 *
 * Activa Feynman mode escribiendo el campo `feynman` en el session file
 * de hoy. El hook UserPromptSubmit lo lee en cada turno e inyecta la
 * directiva de rol invertido (el usuario ensena, el modelo sondea).
 *
 * Uso: bun run start-teach.ts --topic "<topic>"
 *
 * Exit codes:
 *   0  activacion exitosa
 *   2  topic invalido, o ya hay un teach activo
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

interface FeynmanState {
  topic: string
  started_at: string
  gaps: string[]
}

interface SessionDoc {
  date: string
  turns: unknown[]
  hint_state?: unknown
  last_calibration_eval_turn?: number
  feynman?: FeynmanState
  feynman_summaries?: unknown[]
}

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function normalizeTopic(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
}

function parseArgs(argv: string[]): { topic: string } {
  let rawTopic: string | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--topic" && i + 1 < argv.length) {
      rawTopic = argv[i + 1]!
      i++
    }
  }
  if (!rawTopic) {
    process.stderr.write("usage: start-teach --topic <topic>\n")
    process.exit(2)
  }
  const normalized = normalizeTopic(rawTopic)
  if (!normalized) {
    process.stderr.write(`invalid topic: ${JSON.stringify(rawTopic)} (must produce alphanumeric slug)\n`)
    process.exit(2)
  }
  return { topic: normalized }
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

function readSessionDoc(path: string): SessionDoc {
  if (!existsSync(path)) return { date: todayIso(), turns: [] }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SessionDoc
  } catch {
    // Corrupted session file — preserve the bad copy for forensics and
    // start fresh so the user can activate teach mode without manual
    // intervention.
    try {
      const backup = `${path}.corrupt-${Date.now()}`
      writeFileSync(backup, readFileSync(path))
      process.stderr.write(`[warn] session file was corrupted — backed up to ${backup}\n`)
    } catch {
      // ignore backup failures (disk full, permissions) — still start fresh
    }
    return { date: todayIso(), turns: [] }
  }
}

function main(): void {
  const { topic } = parseArgs(process.argv.slice(2))
  const sessionPath = join(stateDir(), "sessions", `${todayIso()}.json`)
  const doc: SessionDoc = readSessionDoc(sessionPath)

  if (doc.feynman) {
    process.stderr.write(
      `teach already active: "${doc.feynman.topic}" (started ${doc.feynman.started_at})\n` +
        `run /socratiskill:socratic endteach first to switch topics\n`,
    )
    process.exit(2)
  }

  doc.feynman = {
    topic,
    started_at: new Date().toISOString(),
    gaps: [],
  }

  ensureDir(dirname(sessionPath))
  writeFileSync(sessionPath, JSON.stringify(doc, null, 2))
  process.stdout.write(`teach mode on: ${topic}\n`)
  process.stdout.write(`your next turn: YOU explain ${topic}. i will probe for gaps, not teach.\n`)
  process.stdout.write(`to end: /socratiskill:socratic endteach\n`)
}

main()
