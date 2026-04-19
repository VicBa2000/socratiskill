/**
 * end-teach.ts — CLI del subcomando endteach.
 *
 * Cierra Feynman mode del session file de hoy:
 *   - Mueve el `feynman` activo a `feynman_summaries[]` con started/ended/duracion.
 *   - Imprime el resumen al usuario.
 *   - Fase 6 (journal) cosechara `feynman_summaries[]` para el daily.
 *
 * Uso: bun run end-teach.ts
 *
 * Exit codes:
 *   0  cierre exitoso
 *   2  no hay teach activo
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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

interface SessionDoc {
  date: string
  turns: unknown[]
  feynman?: FeynmanState
  feynman_summaries?: FeynmanSummary[]
}

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function main(): void {
  const sessionPath = join(stateDir(), "sessions", `${todayIso()}.json`)
  if (!existsSync(sessionPath)) {
    process.stderr.write("no teach session active\n")
    process.exit(2)
  }
  const doc = JSON.parse(readFileSync(sessionPath, "utf-8")) as SessionDoc
  if (!doc.feynman) {
    process.stderr.write("no teach session active\n")
    process.exit(2)
  }

  const endedAt = new Date()
  const startedAt = new Date(doc.feynman.started_at)
  const durationMinutes = Math.max(
    0,
    Math.round((endedAt.getTime() - startedAt.getTime()) / 60000),
  )

  const summary: FeynmanSummary = {
    topic: doc.feynman.topic,
    started_at: doc.feynman.started_at,
    ended_at: endedAt.toISOString(),
    duration_minutes: durationMinutes,
    gap_count: doc.feynman.gaps.length,
    gaps: [...doc.feynman.gaps],
  }

  if (!doc.feynman_summaries) doc.feynman_summaries = []
  doc.feynman_summaries.push(summary)
  delete doc.feynman

  writeFileSync(sessionPath, JSON.stringify(doc, null, 2))

  process.stdout.write(
    `teach ended: ${summary.topic} (${summary.duration_minutes}min, ${summary.gap_count} gaps)\n`,
  )
  if (summary.gaps.length > 0) {
    process.stdout.write("gaps detected:\n")
    for (const g of summary.gaps) process.stdout.write(`  - ${g}\n`)
  } else {
    process.stdout.write(
      "no gaps logged — either a solid explanation or the model skipped feynman_gap in HINT_META.\n",
    )
  }
}

main()
