/**
 * antipatterns.ts — detector y state manager de antipatrones.
 *
 * Funciones puras:
 *   - extractCodeBlocks(text)     fenced code blocks (``` ... ```)
 *   - scanText(code, defs)        count de matches por antipattern id
 *   - applyScanToState(state, scan, now) -> new state
 *
 * Functions con side-effect (para los hooks):
 *   - loadDefinitions()           lee data/antipatterns.json (import estatico)
 *   - readState() / writeState()  lee/escribe ~/.claude/socratic/antipatterns.json
 *   - getActive(state)            devuelve entries con active=true
 *
 * Thresholds por default: activar al llegar a 3 ocurrencias totales;
 * desactivar tras 5 turnos consecutivos sin matches (mientras estaba
 * activo). Overridable via campos del JSON de definitions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import DEFS_JSON from "../data/antipatterns.json"

export namespace Antipatterns {
  export interface Definition {
    id: string
    name: string
    language: string
    severity: string
    regex: string
    flags: string
    fix: string
  }

  export interface Entry {
    id: string
    occurrence_count: number
    consecutive_clean: number
    last_seen: string | null
    active: boolean
    activated_at: string | null
  }

  export interface State {
    [id: string]: Entry
  }

  export interface Config {
    activation_threshold: number
    deactivation_clean_streak: number
    antipatterns: Definition[]
  }

  const CONFIG = DEFS_JSON as unknown as Config

  export const ACTIVATION_THRESHOLD = CONFIG.activation_threshold ?? 3
  export const DEACTIVATION_CLEAN_STREAK = CONFIG.deactivation_clean_streak ?? 5

  export function loadDefinitions(): Definition[] {
    return CONFIG.antipatterns ?? []
  }

  function stateDir(): string {
    return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
  }

  function statePath(): string {
    return join(stateDir(), "antipatterns.json")
  }

  export function readState(): State {
    const p = statePath()
    if (!existsSync(p)) return {}
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as State
    } catch {
      return {}
    }
  }

  export function writeState(state: State): void {
    const p = statePath()
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(state, null, 2))
  }

  /** Extract contents of fenced code blocks. Returns array of code-only strings. */
  export function extractCodeBlocks(text: string): string[] {
    if (!text) return []
    const out: string[] = []
    const re = /```[^\n]*\n?([\s\S]*?)```/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      out.push(m[1] ?? "")
    }
    return out
  }

  /** Count matches of each antipattern regex in `code`. */
  export function scanText(code: string, defs: Definition[]): Record<string, number> {
    const result: Record<string, number> = {}
    if (!code) return result
    for (const d of defs) {
      try {
        const re = new RegExp(d.regex, d.flags || "g")
        const matches = code.match(re)
        if (matches && matches.length > 0) result[d.id] = matches.length
      } catch {
        // malformed regex — skip
      }
    }
    return result
  }

  function emptyEntry(id: string): Entry {
    return {
      id,
      occurrence_count: 0,
      consecutive_clean: 0,
      last_seen: null,
      active: false,
      activated_at: null,
    }
  }

  /**
   * Apply a scan result to the state. Updates occurrence_count / consecutive_clean
   * and toggles `active` per thresholds. Returns the new state object (mutates input too).
   */
  export function applyScanToState(
    state: State,
    scan: Record<string, number>,
    now: Date,
    defs: Definition[] = loadDefinitions(),
  ): State {
    for (const d of defs) {
      const entry = state[d.id] ?? emptyEntry(d.id)
      const count = scan[d.id] ?? 0
      if (count > 0) {
        entry.occurrence_count += count
        entry.last_seen = now.toISOString()
        entry.consecutive_clean = 0
        if (!entry.active && entry.occurrence_count >= ACTIVATION_THRESHOLD) {
          entry.active = true
          entry.activated_at = now.toISOString()
        }
      } else if (entry.active) {
        entry.consecutive_clean += 1
        if (entry.consecutive_clean >= DEACTIVATION_CLEAN_STREAK) {
          entry.active = false
        }
      }
      state[d.id] = entry
    }
    return state
  }

  export function getActive(state: State): Entry[] {
    return Object.values(state).filter((e) => e.active)
  }

  /** Convenience: read, scan combined user+agent code, update, write. Returns new state. */
  export function recordTurn(userText: string, agentText: string, now: Date = new Date()): State {
    const defs = loadDefinitions()
    const code = [...extractCodeBlocks(userText), ...extractCodeBlocks(agentText)].join("\n\n")
    const scan = scanText(code, defs)
    const state = readState()
    applyScanToState(state, scan, now, defs)
    writeState(state)
    return state
  }
}

// CLI entrypoint — for manual inspection.
if (import.meta.main) {
  const cmd = process.argv[2]
  if (cmd === "list-defs") {
    for (const d of Antipatterns.loadDefinitions()) {
      process.stdout.write(`${d.id} (${d.language}, ${d.severity}): ${d.name}\n`)
    }
  } else if (cmd === "state") {
    process.stdout.write(JSON.stringify(Antipatterns.readState(), null, 2) + "\n")
  } else if (cmd === "scan") {
    const text = readFileSync(0, "utf-8")
    const defs = Antipatterns.loadDefinitions()
    const code = [...Antipatterns.extractCodeBlocks(text)].join("\n\n")
    process.stdout.write(JSON.stringify(Antipatterns.scanText(code, defs), null, 2) + "\n")
  } else {
    process.stdout.write("usage: bun run antipatterns.ts [list-defs | state | scan < text]\n")
  }
}
