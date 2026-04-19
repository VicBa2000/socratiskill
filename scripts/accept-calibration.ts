/**
 * accept-calibration.ts — applies a pending_calibration_change to profile.
 *
 * Triggered by /socratiskill:socratic accept after build-context has injected
 * a calibration suggestion and the user agreed verbally. Effects:
 *
 *   1. Reads profile.pending_calibration_change. If absent, exits 2 with
 *      a stderr message.
 *   2. Writes profile.global_level = pending.to.
 *   3. Resets today's hint_state to getInitialHintLevel(newLevel), clearing
 *      consecutive counters — the automatic momentum belongs to the old
 *      level, not the new one.
 *   4. Deletes pending_calibration_change so the hook stops nagging.
 *   5. Prints a single confirmation line.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { HintState } from "./hint-state"
import ROLES_JSON from "../data/roles.json"

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

function main(): void {
  const profilePath = join(stateDir(), "profile.json")
  const profile = readJson<Record<string, unknown>>(profilePath, {})
  const pending = profile["pending_calibration_change"] as
    | { direction: "up" | "down"; from: number; to: number; reason: string }
    | undefined
  if (!pending) {
    process.stderr.write("error: no pending calibration change\n")
    process.exit(2)
  }

  const newLevel = HintState.clampUserLevel(Number(pending.to))
  const role = ROLES[newLevel] ?? "Pair programmer"

  profile["global_level"] = newLevel
  delete profile["pending_calibration_change"]
  writeJson(profilePath, profile)

  const sessPath = join(stateDir(), "sessions", `${todayIso()}.json`)
  type SessionDoc = {
    date: string
    turns: unknown[]
    hint_state?: HintState.State
    last_calibration_eval_turn?: number
  }
  const doc = readJson<SessionDoc>(sessPath, { date: todayIso(), turns: [] })
  doc.hint_state = HintState.createInitialState(newLevel)
  writeJson(sessPath, doc)

  process.stdout.write(`calibration accepted: level ${pending.from} -> ${newLevel} (${role})\n`)
}

main()
