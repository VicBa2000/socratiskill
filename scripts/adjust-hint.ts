/**
 * adjust-hint.ts — manual mutator for today's hint_state.currentLevel.
 *
 * Used by the /socratiskill:socratic subcommands `hint`, `faster`, `slower`.
 * Unlike the automatic hint-state transitions (driven by processResponse on
 * each turn), a manual adjustment does NOT touch consecutiveFailures /
 * consecutiveSuccesses — those represent the automatic momentum and we do
 * not want a manual nudge to reset that signal.
 *
 * CLI: bun run adjust-hint.ts --delta <±N>
 *      bun run adjust-hint.ts --set <0-5>
 *
 * Writes updated hint_state to today's session file and prints a one-line
 * summary. Fail-fast (non-zero exit) so the caller can show stderr.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { HintState } from "./hint-state"

interface Args {
  delta?: number
  set?: number
}

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    if (a === "--delta" && v !== undefined) {
      out.delta = Number(v)
      i++
    } else if (a === "--set" && v !== undefined) {
      out.set = Number(v)
      i++
    }
  }
  return out
}

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
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
  writeFileSync(path, JSON.stringify(data, null, 2))
}

function loadProfileLevel(): number {
  const p = join(stateDir(), "profile.json")
  const data = readJson<Record<string, unknown>>(p, {})
  return Math.min(5, Math.max(1, Number(data["global_level"]) || 3))
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.delta === undefined && args.set === undefined) {
    process.stderr.write("error: expected --delta <N> or --set <0-5>\n")
    process.exit(2)
  }
  if (args.delta !== undefined && !Number.isFinite(args.delta)) {
    process.stderr.write(`error: invalid --delta value\n`)
    process.exit(2)
  }
  if (args.set !== undefined && !Number.isFinite(args.set)) {
    process.stderr.write(`error: invalid --set value\n`)
    process.exit(2)
  }

  const sessPath = join(stateDir(), "sessions", `${todayIso()}.json`)
  type SessionDoc = {
    date: string
    turns: unknown[]
    hint_state?: HintState.State
    last_calibration_eval_turn?: number
  }
  const doc = readJson<SessionDoc>(sessPath, { date: todayIso(), turns: [] })
  if (!doc.hint_state) {
    const lvl = HintState.clampUserLevel(loadProfileLevel())
    doc.hint_state = HintState.createInitialState(lvl)
  }

  const previous = doc.hint_state.currentLevel
  let target: number
  if (args.set !== undefined) {
    target = args.set
  } else {
    target = previous + (args.delta as number)
  }
  const newLevel = HintState.clampHint(target)
  doc.hint_state.currentLevel = newLevel
  doc.hint_state.zeroKnowledgeActive = false

  writeJson(sessPath, doc)

  process.stdout.write(
    `hint adjusted: ${previous} -> ${newLevel} (${HintState.hintName(newLevel)})\n`,
  )
}

main()
