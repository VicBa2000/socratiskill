/**
 * pick-review.ts — CLI del subcomando review.
 *
 * Lee error-map.json, filtra cards con next_review_at <= now Y !resolved,
 * ordena por next_review_at ascendente (mas vencidas primero), e imprime
 * la card mas overdue en formato key:value (para que el modelo lo parse
 * y genere una pregunta de review sobre el topic).
 *
 * Uso:
 *   bun run pick-review.ts           # imprime la card mas overdue
 *   bun run pick-review.ts --all     # imprime todas las due
 *
 * Exit codes: siempre 0. "no cards" es caso valido, no error.
 */

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function readErrorMap(): ErrorMapEntry[] {
  const p = join(stateDir(), "error-map.json")
  if (!existsSync(p)) return []
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown
    if (Array.isArray(raw)) return raw as ErrorMapEntry[]
    if (raw && typeof raw === "object") {
      return Object.values(raw as Record<string, ErrorMapEntry>)
    }
    return []
  } catch {
    return []
  }
}

function formatOverdueBy(ms: number): string {
  if (ms <= 0) return "0h"
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
  if (days > 0) return `${days}d${hours}h`
  return `${hours}h`
}

function formatCard(entry: ErrorMapEntry, now: number): string {
  const nextAt = entry.next_review_at ? Date.parse(entry.next_review_at) : NaN
  const overdueMs = Number.isNaN(nextAt) ? 0 : now - nextAt
  const lines = [
    `topic: ${entry.topic}`,
    `domain: ${entry.domain ?? "(unknown)"}`,
    `fails: ${entry.fail_count}`,
    `successes: ${entry.success_count}`,
    `leitner_box: ${entry.leitner_box}`,
    `last_seen: ${entry.last_seen}`,
    `next_review_at: ${entry.next_review_at ?? "(none)"}`,
    `overdue_by: ${formatOverdueBy(overdueMs)}`,
    `last_hint_level: ${entry.last_hint_level}`,
  ]
  return lines.join("\n")
}

function main(): void {
  const all = process.argv.slice(2).includes("--all")
  const now = Date.now()
  const due = readErrorMap()
    .filter((e) => {
      if (!e || e.resolved) return false
      if (!e.next_review_at) return false
      const t = Date.parse(e.next_review_at)
      return !Number.isNaN(t) && t <= now
    })
    .sort((a, b) => Date.parse(a.next_review_at!) - Date.parse(b.next_review_at!))

  if (due.length === 0) {
    process.stdout.write("no review cards due\n")
    return
  }

  if (all) {
    process.stdout.write(`${due.length} due card(s):\n`)
    for (const entry of due) {
      process.stdout.write("---\n")
      process.stdout.write(formatCard(entry, now) + "\n")
    }
    return
  }

  process.stdout.write(`review card found (${due.length} due total, showing most overdue):\n`)
  process.stdout.write(formatCard(due[0]!, now) + "\n")
}

main()
