/**
 * gate-tool.ts — engine of the PreToolUse hook.
 *
 * While immersive mode is active the agent does not write code; the user
 * does. Every other rule in this plugin is a soft instruction injected as
 * text and obeyed at the model's discretion — this one is not. A level-1
 * turn once wrote 378 lines despite explicit limits (see cambios.txt,
 * Tarea 10.A.2), so "write nothing at all" cannot rest on obedience.
 *
 * Claude Code lets a PreToolUse hook refuse a call outright by printing
 * a permissionDecision of "deny" (validated empirically, Tarea I.0.1).
 * The tool never runs and the model receives our reason verbatim.
 *
 * Fail-open everywhere: any unexpected state allows the call. A gate that
 * misfires and blocks real work gets the whole plugin uninstalled.
 */

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { HintState } from "./hint-state"
import { Immersive } from "./immersive-state"
import { StateIO } from "./state-io"

interface HookInput {
  tool_name?: string
  tool_input?: Record<string, unknown>
  hook_event_name?: string
  cwd?: string
}

/** Tools that put code on disk. Denied outright while immersive. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

/** Delegation loophole: a subagent writing on the agent's behalf. */
const DELEGATION_TOOLS = new Set(["Agent", "Task"])

export namespace Gate {
  export interface Verdict {
    allow: boolean
    reason?: string
    /** Which rule fired, for the telemetry in Fase 4. */
    rule?: string
    /** Set when the allow consumed a scaffold slot; caller must persist. */
    scaffoldLines?: number
  }

  /**
   * Lines in a file's content. A trailing newline terminates the last
   * line rather than starting a new one.
   */
  export function countLines(content: string): number {
    if (!content) return 0
    const n = content.split("\n").length
    return content.endsWith("\n") ? n - 1 : n
  }

  /**
   * Shell commands that write files, i.e. Bash used as an editor.
   *
   * Deliberately conservative: the user NEEDS Bash to run their own tests,
   * git, linters and builds while they work. Only unmistakable
   * write-to-file vectors are listed. Redirections to /dev/null and to
   * file descriptors (2>&1, >&2) are excluded — those are plumbing, not
   * authoring.
   */
  const WRITE_PATTERNS: Array<{ id: string; re: RegExp }> = [
    // `> file` / `>> file`, but not `>/dev/null`, `2>&1`, `>&2`
    { id: "shell-redirect", re: /(?<!\d)>>?\s*(?!&)(?!\/dev\/null\b)(?!\/dev\/stderr\b)[^\s;|&]+/ },
    { id: "tee", re: /\btee\b/ },
    { id: "inplace-edit", re: /\b(sed|perl|ruby)\b[^;|&]*\s-[a-zA-Z]*i\b/ },
    { id: "inplace-awk", re: /\bawk\b[^;|&]*-i\s+inplace/ },
    { id: "dd-output", re: /\bdd\b[^;|&]*\bof=/ },
    { id: "truncate", re: /\btruncate\b/ },
    { id: "patch", re: /\bpatch\b|\bgit\s+apply\b/ },
    // node/python/etc. used as a file writer
    { id: "script-write", re: /writeFileSync|createWriteStream|\bopen\s*\([^)]*['"][wax]/ },
  ]

  export function detectDisguisedWrite(command: string): string | null {
    if (!command) return null
    for (const p of WRITE_PATTERNS) {
      if (p.re.test(command)) return p.id
    }
    return null
  }

  /**
   * Windows gives backslashes and arbitrary case, and a path may contain
   * `..` segments that walk back out of the directory it appears to be
   * under. resolve() collapses those before we compare — without it,
   * "<state>/../anything.ts" would pass a naive prefix test.
   */
  function normalize(p: string): string {
    return resolve(p).replace(/\\/g, "/").toLowerCase()
  }

  /**
   * The plugin's own state is not the user's code. `socratic off`,
   * `level N` and `challenge` all mutate profile.json through the Write
   * tool, so gating that path would let immersive mode block the very
   * commands that turn it off — a lock whose key is inside the locked
   * room. The escape hatches must never depend on the gate's goodwill.
   */
  function isPluginState(toolInput: Record<string, unknown>, stateDir: string): boolean {
    const target = toolInput["file_path"] ?? toolInput["notebook_path"]
    if (typeof target !== "string" || target.length === 0) return false
    // Compare on a separator boundary: a bare prefix test would also
    // exempt a sibling directory whose name merely starts the same way
    // (".../socratic-backup/x" against ".../socratic").
    const dir = normalize(stateDir).replace(/\/+$/, "")
    const t = normalize(target)
    return t === dir || t.startsWith(dir + "/")
  }

  export function decide(
    toolName: string,
    toolInput: Record<string, unknown>,
    rung: number,
    stateDir: string,
    scaffold?: Immersive.Scaffold | null,
  ): Verdict {
    if (isPluginState(toolInput, stateDir)) return { allow: true }

    // Scaffold window: the user has explicitly conceded that the agent
    // may create the skeleton of something new.
    //
    // The line is CREATE vs EDIT, and it is the only one the gate can
    // draw without adjudicating. "Is this boilerplate or is this the
    // code that teaches them?" is a judgment call, and a judgment call
    // handed to the model is one the model's helpfulness gradient will
    // widen until the window swallows the whole feature. Whether a file
    // already exists is a fact.
    if (scaffold && toolName === "Write") {
      const target = toolInput["file_path"]
      if (typeof target === "string" && target.length > 0) {
        if (existsSync(target)) {
          return {
            allow: false,
            rule: "scaffold:existing-file",
            reason:
              `IMMERSIVE MODE: the scaffold window lets you CREATE files that do not exist yet — ${target} already does, so writing it is an edit, and editing is implementing. ` +
              "Tell the user what needs to change in it and let them make the change.",
          }
        }
        const content = typeof toolInput["content"] === "string" ? (toolInput["content"] as string) : ""
        const lines = countLines(content)
        if (lines > scaffold.max_lines_per_file) {
          return {
            allow: false,
            rule: "scaffold:too-many-lines",
            reason:
              `IMMERSIVE MODE: ${lines} lines exceeds the ${scaffold.max_lines_per_file}-line scaffold limit for a single file. ` +
              "A scaffold is a skeleton, not an implementation — create the structure and leave the bodies for the user.",
          }
        }
        return { allow: true, rule: "scaffold:create", scaffoldLines: lines }
      }
    }

    const r = Immersive.rung(rung)
    const coach =
      `You are at rung ${rung} (${r.name}) of the immersive ladder. ${r.directive} ` +
      "Do not paste a code block for them to copy either — that is the same failure with extra steps."

    if (WRITE_TOOLS.has(toolName)) {
      // Edit/MultiEdit stay blocked even with a window open: they only
      // apply to files that already exist, which is implementing.
      const scaffoldNote = scaffold
        ? ` A scaffold window is open, but it only covers CREATING new files with Write — ${toolName} modifies what is already there.`
        : " If they have a real deadline, tell them about /socratiskill:socratic unlock <reason> and drop it."
      return {
        allow: false,
        rule: "write-tool",
        reason:
          `IMMERSIVE MODE: ${toolName} is blocked. The user is deliberately training their own coding ability — they write the code this session, you coach. ` +
          coach +
          scaffoldNote,
      }
    }

    if (DELEGATION_TOOLS.has(toolName)) {
      return {
        allow: false,
        rule: "delegation",
        reason:
          "IMMERSIVE MODE: delegating to a subagent is blocked — a subagent writing the code is the same as you writing it. " +
          coach,
      }
    }

    if (toolName === "Bash") {
      const command = typeof toolInput["command"] === "string" ? (toolInput["command"] as string) : ""
      const hit = detectDisguisedWrite(command)
      if (hit) {
        return {
          allow: false,
          rule: `bash:${hit}`,
          reason:
            `IMMERSIVE MODE: this Bash command writes to a file (${hit}), which is Write with extra steps. ` +
            "Running the user's tests, git, builds and linters is allowed and encouraged — authoring files is not. " +
            coach,
        }
      }
    }

    return { allow: true }
  }
}

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function main(): void {
  let raw = ""
  try {
    raw = readFileSync(0, "utf-8")
  } catch {
    return
  }

  let input: HookInput = {}
  try {
    input = JSON.parse(raw) as HookInput
  } catch {
    return
  }

  const toolName = String(input.tool_name ?? "")
  if (!toolName) return

  const profilePath = join(stateDir(), "profile.json")
  if (!existsSync(profilePath)) return

  let profile: Record<string, unknown>
  try {
    profile = JSON.parse(readFileSync(profilePath, "utf-8")) as Record<string, unknown>
  } catch {
    return
  }

  if (profile["enabled"] === false) return

  const state = Immersive.isState(profile["immersive"]) ? profile["immersive"] : null
  const now = new Date()
  if (!Immersive.isActive(state, now)) return

  // A logged unlock is a deliberate escape hatch, and while it lasts the
  // gate stands down completely. Real work has real deadlines; a lock with
  // no exit is a lock that gets uninstalled.
  if (Immersive.isUnlocked(state, now)) return

  const level = Math.min(5, Math.max(1, Number(profile["global_level"]) || 3))
  const rung = readRung(level)

  const scaffold = Immersive.isScaffoldOpen(state, now) ? state!.scaffold! : null

  const verdict = Gate.decide(toolName, input.tool_input ?? {}, rung, stateDir(), scaffold)

  if (verdict.allow) {
    if (verdict.scaffoldLines !== undefined) consumeScaffoldSlot(verdict.scaffoldLines)
    return
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: verdict.reason,
      },
    }) + "\n",
  )
}

/**
 * Charge one file against the open scaffold window.
 *
 * This is the one place the gate writes state, so it takes the same
 * profile lock every other writer uses. Two caveats, both deliberate:
 *
 *  - It counts at ALLOW time, not at completion. If the write fails
 *    afterwards the window is charged for a file that never landed.
 *    That error runs against the user (it subtracts lines they did not
 *    receive), and closing the gap would mean a fourth hook firing on
 *    every tool call — not worth it for a rare case.
 *  - It is best-effort: if the bookkeeping throws, the write still
 *    goes through. A gate that blocks real work because it could not
 *    update a counter would be worse than one that miscounts.
 */
function consumeScaffoldSlot(lines: number): void {
  const p = join(stateDir(), "profile.json")
  try {
    StateIO.withLock(`${p}.lock`, () => {
      const fresh = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>
      const st = fresh["immersive"] as Immersive.State | undefined
      if (!st || !st.scaffold) return
      st.scaffold.files_used = (Number(st.scaffold.files_used) || 0) + 1
      st.scaffold.lines_written = (Number(st.scaffold.lines_written) || 0) + lines
      StateIO.writeJsonAtomic(p, fresh)
    })
  } catch {
    /* best-effort: never block a permitted write over bookkeeping */
  }
}

/** Today's live rung, falling back to the level's starting rung. */
function readRung(level: number): number {
  const today = new Date().toISOString().slice(0, 10)
  const p = join(stateDir(), "sessions", `${today}.json`)
  if (existsSync(p)) {
    try {
      const doc = JSON.parse(readFileSync(p, "utf-8")) as { hint_state?: HintState.State }
      if (doc.hint_state && typeof doc.hint_state.currentLevel === "number") {
        return HintState.clampHint(doc.hint_state.currentLevel)
      }
    } catch {
      /* fall through */
    }
  }
  return HintState.getInitialHintLevel(HintState.clampUserLevel(level))
}

main()
