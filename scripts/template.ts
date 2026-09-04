/**
 * template.ts — CLI del subcomando template.
 *
 * "Pasame la plantilla, yo codifico." Activa el modo andamio escribiendo
 * el campo `template` en el session file de hoy. El hook UserPromptSubmit
 * lo lee en cada turno e inyecta la directiva: el agente entrega
 * ESTRUCTURA (firmas, tipos, orden de trabajo en comentarios), para, y el
 * cuerpo lo escribe el usuario.
 *
 * POR QUE EXISTE. En niveles 2-5 esto ya es lo que el nivel hace: el eje
 * define cuanto del trabajo es tuyo y el gate lo aplica. En el nivel 1 no
 * — ahi el agente escribe todo, por diseño (es el nivel de rescate). Un
 * usuario que esta en 1 y quiere teclear el cuerpo tenia que pedirlo a
 * mano cada turno, y como el nivel 1 no arma el gate, `user_wrote` ni
 * siquiera se pedia en HINT_META: el plugin no registraba que el codigo
 * lo habia escrito el usuario. Esto lo vuelve declarable una vez y
 * medible.
 *
 * Es un modo de ENTREGA, no un cambio de nivel. No toca profile.json:
 * vive en el session file, dura lo que dura el dia, y no altera la
 * calibracion salvo por lo que ahora si queda registrado.
 *
 * Uso:
 *   bun run template.ts on
 *   bun run template.ts off
 *
 * Exit codes:
 *   0  cambio aplicado
 *   2  argumento invalido, o el modo ya estaba en ese estado
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { StateIO } from "./state-io"

interface TemplateState {
  started_at: string
  /** Turns elapsed with the mode on. Written by record-turn, read by status. */
  turns: number
}

interface SessionDoc {
  date: string
  turns: unknown[]
  hint_state?: unknown
  last_calibration_eval_turn?: number
  feynman?: unknown
  template?: TemplateState
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

/**
 * Same corruption policy as start-teach: back up the bad copy and start
 * fresh. A user turning a delivery mode on should not have to repair a
 * JSON file by hand to do it.
 */
function readSessionDoc(path: string): SessionDoc {
  if (!existsSync(path)) return { date: todayIso(), turns: [] }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SessionDoc
  } catch {
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

/**
 * Highest level at which the mode is injected. Must match the constant of
 * the same purpose in build-context.ts — above it, the user already writes
 * everything and a template directive could only loosen the level.
 */
const TEMPLATE_MAX_LEVEL = 3

/** The off ramp: the axis switched off, not "a level above 5". */
const OFF_RAMP_LEVEL = 6

/** The current level, or null if there is no readable profile. */
function readLevel(): number | null {
  const p = join(stateDir(), "profile.json")
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>
    const n = Math.round(Number(raw["global_level"]))
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function parseArgs(argv: string[]): "on" | "off" {
  const first = (argv[0] ?? "").trim().toLowerCase()
  if (first === "on" || first === "off") return first
  process.stderr.write("usage: template <on|off>\n")
  process.exit(2)
}

function main(): void {
  const action = parseArgs(process.argv.slice(2))
  const sessionPath = join(stateDir(), "sessions", `${todayIso()}.json`)
  const marker = join(stateDir(), ".template-active")

  // Serialized against record-turn, which writes the same file at the end
  // of every turn. Without the lock, turning the mode on during a busy
  // session can be silently overwritten by the Stop hook's copy.
  //
  // NOTHING inside this callback may call process.exit. Exiting from
  // within skips withLock's finally, which is what unlinks the lock file
  // — and since the stale-lock reclaim (5s) is longer than the acquire
  // timeout (~2.5s), the next invocation does not wait it out, it throws.
  // A refused `on` would leave the session file unwritable for 5 seconds.
  // So the outcome is collected here and acted on after the lock is gone.
  let refusal: string | null = null

  StateIO.withLock(`${sessionPath}.lock`, () => {
    const doc = readSessionDoc(sessionPath)

    if (action === "on") {
      if (doc.template) {
        refusal = `template already on (since ${doc.template.started_at}, ${doc.template.turns} turn(s))\n`
        return
      }
      doc.template = { started_at: new Date().toISOString(), turns: 0 }
    } else {
      if (!doc.template) {
        refusal = "template is not on\n"
        return
      }
      delete doc.template
    }

    ensureDir(dirname(sessionPath))
    StateIO.writeJsonAtomic(sessionPath, doc)

    // Fast-path marker for hook-pre-tool.sh, which runs on EVERY tool call
    // and is written to fork nothing in the common case. Finding today's
    // session file from bash would need UTC date math (a fork, and S34's
    // invariant to get wrong); a zero-byte marker needs one `[[ -f ]]`.
    //
    // It is a HINT, never the truth. gate-tool.ts always re-reads the
    // session doc, so a marker left behind by a session that ended
    // yesterday costs one wasted bun start and cannot produce a wrong
    // verdict. That asymmetry is what makes the duplication safe.
    try {
      if (action === "on") writeFileSync(marker, "")
      else if (existsSync(marker)) unlinkSync(marker)
    } catch {
      // Best-effort: without the marker the gate is simply not armed from
      // the fast path. Never fail the command over a cache file.
    }
  })

  if (refusal) {
    process.stderr.write(refusal)
    process.exit(2)
  }

  if (action === "on") {
    process.stdout.write("template on: you write the bodies.\n")
    process.stdout.write(
      "the agent delivers structure — signatures, types, a numbered work order in comments — and stops.\n",
    )
    // Say it plainly when the mode cannot do anything here, rather than
    // letting the user believe a switch is on that the hook ignores. Above
    // level 3 the user already writes everything, so there is nothing for
    // the mode to take away.
    const level = readLevel()
    if (level !== null && level > TEMPLATE_MAX_LEVEL) {
      // Level 6 is the off ramp — the axis switched off — not "a very high
      // level". Telling someone on the off ramp that they already write
      // everything is the exact inverse of what level 6 does, so the two
      // cases get different sentences.
      const why =
        level === OFF_RAMP_LEVEL
          ? "the axis is off at level 6, so no pedagogical mode is injected"
          : `at level ${level} you already write everything the agent is not allowed to author, so there is nothing for it to take away`
      process.stdout.write(
        `\nnote: ${why}.\n` +
          `the mode changes nothing here and will not be injected. it applies at levels 1-${TEMPLATE_MAX_LEVEL}.\n`,
      )
    }
    process.stdout.write("to end: /socratiskill:socratic template off\n")
  } else {
    process.stdout.write("template off: back to what your level delivers.\n")
  }
}

main()
