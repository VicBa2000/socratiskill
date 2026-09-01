/**
 * migrate-profile.ts — v0.4.x profile -> v0.5 axis schema.
 *
 * WHY THIS IS NOT A SILENT REINTERPRETATION OF THE NUMBER
 *
 * The old axis measured pedagogical overhead; the new one measures
 * authorship. They are different quantities, so no mapping is faithful.
 * One of them is actively dangerous:
 *
 *     old L5 = "silent colleague, writes your code, no questions"
 *     new L5 = "writes nothing at all, asks only"
 *
 * Those are opposites, and BOTH read as "quiet". A user migrated from
 * one to the other would not notice until they hit it — the worst shape
 * a breaking change can have.
 *
 * Level 6 was defined for a different reason entirely (the deliberate
 * off ramp), and it happens to be exactly the old L5. So old-L5 profiles
 * migrate to 6 and keep the behavior they already had, bit for bit.
 * That is what makes this migration safe for the only population that
 * was silently at risk.
 *
 * Everything else maps by identity, except an active immersive session,
 * which was already "the agent writes nothing" and lands on L4.
 *
 * The migration is idempotent and guarded by schema_version. A profile
 * with no schema_version is assumed to be v0.4.x — there was no such
 * field before this version.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { StateIO } from "./state-io"
import { Axis } from "./axis-state"

export namespace Migrate {
  /** Bumped whenever the profile shape changes incompatibly. */
  export const SCHEMA_VERSION = 2

  export interface Result {
    profile: Record<string, unknown>
    changed: boolean
    /** User-facing, shown exactly once. Empty when nothing changed. */
    notice: string
  }

  export function needsMigration(profile: Record<string, unknown> | null | undefined): boolean {
    if (!profile || typeof profile !== "object") return false
    const v = profile["schema_version"]
    return typeof v !== "number" || v < SCHEMA_VERSION
  }

  /**
   * Pure. Takes the parsed profile, returns the migrated one plus the
   * notice to show. No I/O so the hook can apply it inside the lock it
   * already holds, instead of spawning a second process every turn.
   */
  export function migrate(
    profile: Record<string, unknown>,
    now: Date,
  ): Result {
    if (!needsMigration(profile)) {
      return { profile, changed: false, notice: "" }
    }

    const out: Record<string, unknown> = { ...profile }
    const oldLevel = typeof profile["global_level"] === "number" ? Math.round(profile["global_level"] as number) : Axis.DEFAULT_LEVEL

    const immersive = profile["immersive"]
    const immersiveActive =
      immersive !== null &&
      typeof immersive === "object" &&
      (immersive as Record<string, unknown>)["active"] === true

    let newLevel: number
    let reason: string
    if (immersiveActive) {
      // An active immersive session already meant "the agent writes
      // nothing". That is L4 — not L5, which additionally stops
      // directing the work and would be a harder landing than the user
      // asked for.
      newLevel = 4
      reason = "tenías el modo inmersivo activo (el agente no escribía código), que ahora es el nivel 4"
    } else if (oldLevel >= 5) {
      newLevel = Axis.OFF_RAMP
      reason =
        "el viejo nivel 5 era \"escribime el código y callate\", que en el eje nuevo significaría lo contrario. " +
        "El nivel 6 es exactamente el comportamiento que ya tenías"
    } else if (oldLevel < Axis.MIN_LEVEL) {
      newLevel = Axis.MIN_LEVEL
      reason = "el nivel guardado estaba fuera de rango"
    } else {
      newLevel = oldLevel
      reason = "tu nivel no cambia de número, pero sí de significado"
    }

    out["global_level"] = newLevel
    out["schema_version"] = SCHEMA_VERSION

    // `mode` is gone: `productive` became the `ship` escape and `learn`
    // was the only remaining value, saying nothing the level does not.
    delete out["mode"]

    // The immersive subtree flattens. Only the parts that still mean
    // something survive.
    if (immersive && typeof immersive === "object") {
      const im = immersive as Record<string, unknown>
      const unlocks = im["unlocks"]
      if (Array.isArray(unlocks) && unlocks.length > 0) out["escapes"] = unlocks
      const baseline = im["git_baseline"]
      if (baseline && typeof baseline === "object") out["git_baseline"] = baseline
      // The scaffold window does not carry over: it was a grant with an
      // expiry, and the replacement is a daily budget that starts fresh.
    }
    delete out["immersive"]

    const notice = buildNotice(oldLevel, newLevel, reason, immersiveActive)
    return { profile: out, changed: true, notice }
  }

  function buildNotice(
    oldLevel: number,
    newLevel: number,
    reason: string,
    immersiveActive: boolean,
  ): string {
    const lines: string[] = []
    lines.push("socratiskill se actualizó a v0.5: ahora hay UN solo eje.")
    lines.push("")
    lines.push(
      "El nivel ya no mide cuánto te explica el agente, sino CUÁNTO DEL TRABAJO ES TUYO. " +
        "Los modos inmersivo, scaffold, learn/productive y unlock desaparecieron: " +
        "todos eran consecuencias de que el eje viejo no supiera decir \"esto lo escribís vos\".",
    )
    lines.push("")
    lines.push(`Tu perfil: nivel ${oldLevel} -> nivel ${newLevel}. Motivo: ${reason}.`)
    lines.push("")

    if (newLevel === Axis.OFF_RAMP) {
      // R6.5 / M4: this is the one place level 6 is named to the user,
      // and it has to be honest about what it is and how to leave.
      lines.push(
        "El nivel 6 está fuera del eje pedagógico: el agente escribe todo, sin preguntas. " +
          "Es lo que venías teniendo. El eje nuevo vive en 1-5, y si querés entrar, " +
          "`/socratiskill:socratic level 3` es el punto medio (el agente arma esqueletos, vos escribís los cuerpos).",
      )
    } else if (immersiveActive) {
      lines.push(
        "En el nivel 4 el agente no escribe código: descompone el problema y te señala " +
          "casos ya resueltos en tu repo. Es lo mismo que tenías con inmersivo, sin el switch aparte.",
      )
    } else {
      lines.push(
        `Mirá qué implica ahora con \`/socratiskill:socratic status\`. Si te queda incómodo, ` +
          "el nivel se cambia a mano en cualquier momento.",
      )
    }
    return lines.join("\n")
  }
}

// --- CLI -------------------------------------------------------------------
//
// Also runnable standalone (install.sh, or by hand). The hook applies the
// pure function inside its own lock instead of paying for a spawn.

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function main(): void {
  const path = join(stateDir(), "profile.json")
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    process.stderr.write("no profile to migrate\n")
    process.exit(3)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    process.stderr.write("profile.json is not valid JSON; refusing to migrate\n")
    process.exit(2)
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.stderr.write("profile.json is not an object; refusing to migrate\n")
    process.exit(2)
  }

  const result = Migrate.migrate(parsed as Record<string, unknown>, new Date())
  if (!result.changed) {
    process.stdout.write("profile already at schema v" + Migrate.SCHEMA_VERSION + "; nothing to do\n")
    return
  }

  // The lock is a SIBLING file, never the file being written. Locking
  // profile.json itself would both fail to acquire (the file exists) and,
  // once the stale-lock path let it through, hold an open handle that
  // makes the atomic rename fail with EPERM on Windows.
  StateIO.withLock(`${path}.lock`, () => {
    StateIO.writeJsonAtomic(path, result.profile)
  })
  process.stdout.write(result.notice + "\n")
}

if (process.argv[1] && process.argv[1].includes("migrate-profile")) main()
