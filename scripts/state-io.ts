/**
 * state-io.ts — safe I/O helpers for JSON state under ~/.claude/socratic/.
 *
 * Three problems this module solves:
 *
 *   1. Atomic writes. writeFileSync can leave a half-written file if the
 *      process dies mid-write. writeJsonAtomic goes through a
 *      "<path>.tmp-<pid>-<epoch>" staging file and renames into place.
 *      renameSync is atomic on POSIX, and on Windows it is atomic when
 *      source and destination live on the same volume — which they do,
 *      since we stage in the same directory.
 *
 *   2. Race-safe read-modify-write. profile.json is touched by three
 *      independent scripts (build-context, record-turn, accept-calibration)
 *      that can run concurrently if the user has two Claude Code windows
 *      open. withLock serializes critical sections through an O_EXCL
 *      lock file with retry + stale-lock detection — works on Win/Mac/Linux
 *      without depending on flock(1).
 *
 *   3. Schema validation post-parse. TypeScript casts like
 *      `JSON.parse(raw) as Profile` are erased at runtime, so a corrupted
 *      or schema-shifted JSON produces undefined field accesses that fail
 *      far from the parse site. parseJson runs a narrow runtime guard and
 *      falls back to a caller-supplied default when the shape is wrong.
 *
 * Guards exported by this module validate only the fields consumers
 * actually read downstream, not the full schema. That keeps them cheap
 * and tolerant to additive schema evolution.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

export namespace StateIO {
  // --- atomic writes -------------------------------------------------------

  export function writeJsonAtomic(path: string, data: unknown): void {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2))
      renameSync(tmp, path)
    } catch (e) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // ignore — main error is already in flight
      }
      throw e
    }
  }

  // --- cross-platform lock -------------------------------------------------

  export interface LockOpts {
    /** Max attempts before giving up. Default 50. */
    maxAttempts?: number
    /** Sleep between attempts, ms. Default 50. Total wait ≈ 2.5s with defaults. */
    backoffMs?: number
    /** Age at which a lock is considered abandoned and force-removed. Default 5000ms. */
    staleMs?: number
  }

  /** Synchronous sleep using Atomics. Blocks the thread for `ms` milliseconds. */
  function sleepSync(ms: number): void {
    const ia = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(ia, 0, 0, Math.max(1, ms))
  }

  /**
   * Run `fn` while holding an exclusive lock at `lockPath`. The lock is a
   * zero-byte file created with O_EXCL; if it already exists and its mtime
   * is older than `staleMs`, we assume the owner died and reclaim it.
   *
   * Throws if the lock cannot be acquired within maxAttempts * backoffMs.
   */
  export function withLock<T>(lockPath: string, fn: () => T, opts: LockOpts = {}): T {
    const maxAttempts = opts.maxAttempts ?? 50
    const backoffMs = opts.backoffMs ?? 50
    const staleMs = opts.staleMs ?? 5000

    const dir = dirname(lockPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    let fd: number | null = null
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        fd = openSync(lockPath, "wx")
        break
      } catch (e) {
        const err = e as { code?: string }
        if (err.code !== "EEXIST") throw e
        try {
          const st = statSync(lockPath)
          const age = Date.now() - st.mtimeMs
          if (age > staleMs) {
            try {
              unlinkSync(lockPath)
            } catch {
              // someone else reclaimed it first — fine, fall through and retry
            }
            continue
          }
        } catch {
          // lock vanished between EEXIST and statSync — race, just retry
          continue
        }
        sleepSync(backoffMs)
      }
    }

    if (fd === null) {
      throw new Error(
        `withLock: could not acquire ${lockPath} after ${maxAttempts} attempts (~${maxAttempts * backoffMs}ms)`,
      )
    }

    try {
      return fn()
    } finally {
      try {
        closeSync(fd)
      } catch {
        // already closed — fine
      }
      try {
        unlinkSync(lockPath)
      } catch {
        // another process reclaimed a stale lock we were still holding — fine
      }
    }
  }

  // --- validated parse -----------------------------------------------------

  export type Guard<T> = (x: unknown) => x is T

  export function parseJson<T>(raw: string, guard: Guard<T>, fallback: T): T {
    try {
      const parsed: unknown = JSON.parse(raw)
      return guard(parsed) ? parsed : fallback
    } catch {
      return fallback
    }
  }

  export function readJsonValidated<T>(path: string, guard: Guard<T>, fallback: T): T {
    if (!existsSync(path)) return fallback
    try {
      return parseJson(readFileSync(path, "utf-8"), guard, fallback)
    } catch {
      return fallback
    }
  }

  // --- small helpers used by guards ---------------------------------------

  function isObject(x: unknown): x is Record<string, unknown> {
    return typeof x === "object" && x !== null && !Array.isArray(x)
  }

  // --- domain-specific guards ---------------------------------------------
  //
  // Each guard validates only the fields that downstream code dereferences
  // without further checking. Missing optional fields are allowed; wrong
  // types on required fields trigger the fallback.

  /** Profile minimum: global_level numeric, mode either literal. */
  export const isProfile: Guard<Record<string, unknown>> = (x): x is Record<string, unknown> => {
    if (!isObject(x)) return false
    const level = x["global_level"]
    if (level !== undefined && typeof level !== "number") return false
    const mode = x["mode"]
    if (mode !== undefined && mode !== "learn" && mode !== "productive") return false
    return true
  }

  /** SessionDoc minimum: date string, turns array. */
  export const isSessionDoc: Guard<{ date: string; turns: unknown[] } & Record<string, unknown>> = (
    x,
  ): x is { date: string; turns: unknown[] } & Record<string, unknown> => {
    if (!isObject(x)) return false
    if (typeof x["date"] !== "string") return false
    if (!Array.isArray(x["turns"])) return false
    return true
  }

  /** ErrorMap: accept both the current array form and the legacy object form. */
  export const isErrorMapContainer: Guard<unknown[] | Record<string, unknown>> = (
    x,
  ): x is unknown[] | Record<string, unknown> => {
    return Array.isArray(x) || isObject(x)
  }

  /** Antipattern state: flat record of entries keyed by id. */
  export const isAntipatternState: Guard<Record<string, unknown>> = (
    x,
  ): x is Record<string, unknown> => {
    return isObject(x)
  }

  /** HintMeta: the model-emitted telemetry block. All fields optional, but
   *  at least one recognizable field must be present to count as valid. */
  export const isHintMeta: Guard<{
    topic?: unknown
    correct?: unknown
    domain?: unknown
    hintLevel?: unknown
    accompanied?: unknown
    reason?: unknown
    feynman_gap?: unknown
    readiness?: unknown
    diagnostic?: unknown
  }> = (x): x is {
    topic?: unknown
    correct?: unknown
    domain?: unknown
    hintLevel?: unknown
    accompanied?: unknown
    reason?: unknown
    feynman_gap?: unknown
    readiness?: unknown
    diagnostic?: unknown
  } => {
    if (!isObject(x)) return false
    const known = [
      "topic", "correct", "domain", "hintLevel",
      "accompanied", "reason", "feynman_gap",
      "readiness", "diagnostic",
    ]
    return known.some((k) => k in x)
  }
}
