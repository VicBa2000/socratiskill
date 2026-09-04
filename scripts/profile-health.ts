/**
 * profile-health.ts — reconoce un state dir que un bug dejo inconsistente.
 *
 * POR QUE EXISTE. Arreglar el codigo no arregla el disco. El bug B1 (el
 * hook Stop escribia profile.json durante la pausa) se corrigio en
 * v0.5.3, pero toda maquina que lo sufrio quedo con DOS profiles: el
 * `.paused` real, y un profile.json que el hook fabrico desde `{}`. Ese
 * segundo archivo no tiene global_level, asi que Axis.readLevel devuelve
 * el default 3 — y build-context lo MIGRA, escribiendole `global_level: 3`
 * de verdad. O sea que el residuo no es un default transitorio: se
 * persiste, sobrevive a reiniciar la sesion, y se ve identico a una
 * calibracion que el usuario nunca pidio. Actualizar el plugin no lo
 * toca.
 *
 * Peor: `resume` se niega a actuar con dos profiles en disco (y hace
 * bien, no puede saber cual importa), asi que el usuario queda sin salida
 * por la via normal. Este modulo es lo que le devuelve la salida.
 *
 * LA PARTE DELICADA ES DISTINGUIR EL ARTEFACTO DE UN PROFILE REAL. Este
 * modulo habilita un borrado, asi que un falso positivo le cuesta al
 * usuario su calibracion. La prueba es por FINGERPRINT y es conservadora
 * en la direccion segura: ante la duda, "ambiguous" — que no borra nada y
 * le pregunta.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export namespace ProfileHealth {
  /**
   * La version del codigo QUE SE ESTA EJECUTANDO, leida del manifest que
   * esta al lado de este archivo.
   *
   * POR QUE NO ALCANZA CON `/plugin`. Ese comando informa lo que el
   * marketplace resolvio; esto informa lo que corre. Cuando difieren —
   * update aplicado pero la copia instalada sin refrescar — el usuario
   * ve "actualizado" y sigue sufriendo un bug ya arreglado, y no tiene
   * como notarlo. Es la diferencia entre "el bug sigue vivo" y "estas
   * corriendo codigo viejo", que son dos investigaciones completamente
   * distintas.
   */
  export function runningVersion(): string | null {
    try {
      const manifest = join(import.meta.dir, "..", ".claude-plugin", "plugin.json")
      if (!existsSync(manifest)) return null
      const parsed = JSON.parse(readFileSync(manifest, "utf-8")) as { version?: unknown }
      return typeof parsed.version === "string" ? parsed.version : null
    } catch {
      return null
    }
  }

  /** De donde salio el codigo que corre. Desambigua instalado vs clon local. */
  export function runningFrom(): string {
    return join(import.meta.dir, "..")
  }

  /**
   * Claves que solo escribe init-profile.sh, o sea la huella de un
   * profile creado por la via legitima aunque todavia no se haya
   * calibrado. Si alguna aparece, el archivo NO es un artefacto del hook
   * Stop por mas que le falte la calibracion.
   */
  const INIT_PROFILE_KEYS = ["mode", "comprehension_speed", "copy_tendency", "streak_days"]

  /**
   * Un profile fabricado por record-turn desde su fallback `{}`.
   *
   * Las tres condiciones son conjuntas a proposito:
   *
   *   1. `last_user_message_length` la escribe UNICAMENTE record-turn.
   *      Es la firma positiva de que este archivo lo creo el hook Stop.
   *   2. `calibration_completed !== true` descarta todo profile que haya
   *      pasado por `calibrate`. Un usuario calibrado tambien acumula
   *      last_user_message_length turno a turno, asi que sin esta
   *      condicion la prueba se comeria profiles reales.
   *   3. Ninguna clave de init-profile. Cubre al usuario que nunca
   *      calibro pero cuyo profile si nacio por la via buena.
   *
   * Lo que queda adentro es exactamente el conjunto {last_active,
   * last_user_message_length, global_level, schema_version} y sus
   * subconjuntos: bookkeeping de sesion y lo que le agrego la migracion.
   * Cero configuracion elegida por una persona.
   */
  export function isArtifact(profile: Record<string, unknown>): boolean {
    if (profile["calibration_completed"] === true) return false
    if (typeof profile["last_user_message_length"] !== "number") return false
    for (const k of INIT_PROFILE_KEYS) if (k in profile) return false
    return true
  }

  export type Diagnosis =
    /** Nada que reparar. */
    | { kind: "ok" }
    /**
     * Los dos archivos existen y el activo es un artefacto. Es el caso
     * de B1 y el unico con una respuesta correcta obvia: tirar el
     * artefacto y restaurar el `.paused`.
     */
    | {
        kind: "resurrected"
        activeLevel: number | null
        pausedLevel: number | null
        /**
         * `last_active` del artefacto: CUANDO lo escribio el hook Stop.
         *
         * Es el dato que separa dos diagnosticos que se ven iguales. Un
         * timestamp anterior al update dice "residuo viejo, el codigo ya
         * esta arreglado y esto es lo que quedo". Uno posterior dice que
         * hay un segundo camino todavia abierto y que el fix no alcanzo.
         * Sin esto las dos hipotesis son indistinguibles — y `--apply`
         * borra el archivo, o sea que destruye la evidencia justo cuando
         * el usuario mas la necesita. Por eso se imprime ANTES de tocar
         * nada.
         */
        artifactWrittenAt: string | null
      }
    /**
     * Los dos archivos existen y el activo tiene contenido real — el
     * usuario recalibro durante la pausa, o algo que no previmos. NO se
     * elige por el: se le muestran los dos y decide.
     */
    | { kind: "ambiguous"; activeLevel: number | null; pausedLevel: number | null }
    /**
     * Quedo solo el artefacto: alguien ya borro el `.paused`, o la pausa
     * nunca existio y el profile se fabrico igual. No hay nada que
     * restaurar, pero el nivel que el usuario esta viendo es ficticio y
     * hay que decirlo.
     */
    | { kind: "orphan"; activeLevel: number | null; artifactWrittenAt: string | null }

  function readProfile(p: string): Record<string, unknown> | null {
    if (!existsSync(p)) return null
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }

  function levelOf(p: Record<string, unknown> | null): number | null {
    if (!p) return null
    const raw = p["global_level"]
    return typeof raw === "number" ? Math.round(raw) : null
  }

  function writtenAt(p: Record<string, unknown> | null): string | null {
    if (!p) return null
    const raw = p["last_active"]
    return typeof raw === "string" && raw.length > 0 ? raw : null
  }

  export function paths(stateDir: string): { active: string; paused: string } {
    return {
      active: join(stateDir, "profile.json"),
      paused: join(stateDir, "profile.json.paused"),
    }
  }

  /**
   * Fail-safe, no fail-open: un archivo ilegible devuelve "ok" y no
   * dispara ninguna reparacion. Este modulo puede BORRAR, asi que
   * cualquier estado que no entienda tiene que terminar en "no tocar
   * nada", nunca en "asumir que es basura".
   */
  export function inspect(stateDir: string): Diagnosis {
    const { active, paused } = paths(stateDir)
    const hasActive = existsSync(active)
    const hasPaused = existsSync(paused)

    if (!hasActive) return { kind: "ok" }

    const activeDoc = readProfile(active)
    if (!activeDoc) return { kind: "ok" }

    const artifact = isArtifact(activeDoc)

    if (hasPaused) {
      const pausedDoc = readProfile(paused)
      // Un `.paused` corrupto no se puede restaurar, asi que no se ofrece
      // como si se pudiera.
      if (!pausedDoc) return { kind: "ambiguous", activeLevel: levelOf(activeDoc), pausedLevel: null }
      if (!artifact) {
        return { kind: "ambiguous", activeLevel: levelOf(activeDoc), pausedLevel: levelOf(pausedDoc) }
      }
      return {
        kind: "resurrected",
        activeLevel: levelOf(activeDoc),
        pausedLevel: levelOf(pausedDoc),
        artifactWrittenAt: writtenAt(activeDoc),
      }
    }

    if (artifact) {
      return { kind: "orphan", activeLevel: levelOf(activeDoc), artifactWrittenAt: writtenAt(activeDoc) }
    }
    return { kind: "ok" }
  }

  /** Una linea para el contexto por turno. null cuando no hay nada que decir. */
  export function warning(d: Diagnosis): string | null {
    switch (d.kind) {
      case "resurrected":
        return (
          `STATE INCONSISTENT — the level shown above (${d.activeLevel ?? "?"}) is NOT the user's level. ` +
          `A known bug (fixed in v0.5.3) recreated profile.json while the plugin was paused; the real profile ` +
          `is parked in profile.json.paused${d.pausedLevel !== null ? ` at level ${d.pausedLevel}` : ""}. ` +
          "Tell the user to run `/socratiskill:socratic repair` and do not treat the current level as chosen."
        )
      case "ambiguous":
        return (
          "STATE INCONSISTENT — both profile.json and profile.json.paused exist, and the active one holds real " +
          "settings, so the plugin cannot tell which the user wants. Tell them to run " +
          "`/socratiskill:socratic repair`, which shows both and lets them pick."
        )
      case "orphan":
        return (
          `STATE INCONSISTENT — profile.json was auto-generated by the Stop hook, never by calibration, so level ` +
          `${d.activeLevel ?? "?"} is a default nobody chose. Tell the user to run ` +
          "`/socratiskill:socratic repair`."
        )
      case "ok":
        return null
    }
  }
}
