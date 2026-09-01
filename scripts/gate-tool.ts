/**
 * gate-tool.ts — engine of the PreToolUse hook.
 *
 * Above level 1 the agent does not author the code; the user does. Every
 * other rule in this plugin is a soft instruction injected as text and
 * obeyed at the model's discretion — this one is not. A level-1 turn once
 * wrote 378 lines despite explicit limits (cambios.txt, Tarea 10.A.2), so
 * "you do not write this" cannot rest on obedience.
 *
 * Claude Code lets a PreToolUse hook refuse a call outright by printing a
 * permissionDecision of "deny" (validated empirically, Tarea I.0.1). The
 * tool never runs and the model receives our reason verbatim.
 *
 * THREE LAYERS, in the order they fire:
 *
 *   1. CREATE vs EDIT — the only authorship boundary that can be drawn
 *      without anyone's opinion. Editing an existing file is implementing.
 *   2. SHAPE — a created file must look like a skeleton, not an
 *      implementation (shape-check.ts). This is what closes the hole that
 *      the v0.4 scaffold window only bounded by being short-lived.
 *   3. BUDGET — a daily cap on created files, bounding the blast radius
 *      when the first two are fooled.
 *
 * Fail-open everywhere: any unexpected state allows the call. A gate that
 * misfires and blocks real work gets the whole plugin uninstalled. L1, the
 * off ramp and an open escape all disarm it by construction.
 */

import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { HintState } from "./hint-state"
import { Axis } from "./axis-state"
import { ShapeCheck } from "./shape-check"
import { StateIO } from "./state-io"
import LEVELS_JSON from "../data/levels.json"

interface HookInput {
  tool_name?: string
  tool_input?: Record<string, unknown>
  hook_event_name?: string
  cwd?: string
}

/** Tools that put code on disk. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

/** Delegation loophole: a subagent writing on the agent's behalf. */
const DELEGATION_TOOLS = new Set(["Agent", "Task"])

/** Tools that can only ever touch a file that already exists. */
const EDIT_ONLY_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"])

export namespace Gate {
  export interface Verdict {
    allow: boolean
    reason?: string
    /** Which rule fired, for the telemetry. */
    rule?: string
    /** Set when the allow charged a file against the daily budget. */
    chargedLines?: number
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
   * Deliberately conservative — WHEN IN DOUBT, ALLOW. The user NEEDS Bash
   * to run their own tests, git, linters and builds while they work, and a
   * false positive here blocks exactly the activity the axis exists to
   * produce. Only unmistakable write-to-file vectors are listed.
   * Redirections to /dev/null and to file descriptors (2>&1, >&2) are
   * excluded — those are plumbing, not authoring.
   *
   * NOTE the opposite polarity in shape-check.ts, which is deliberately
   * RESTRICTIVE. Not an inconsistency: there a false positive only costs
   * the agent a retry. Do not harmonize them.
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
   * tool, so gating that path would let the axis block the very commands
   * that change it — a lock whose key is inside the locked room. The
   * escape hatches must never depend on the gate's goodwill.
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

  export interface DecideInput {
    toolName: string
    toolInput: Record<string, unknown>
    contract: Axis.GateContract
    rung: number
    stateDir: string
    shapeConfig?: ShapeCheck.Config
  }

  export function decide(input: DecideInput): Verdict {
    const { toolName, toolInput, contract, rung, stateDir } = input
    const shapeConfig = input.shapeConfig ?? ShapeCheck.DEFAULT_CONFIG

    if (isPluginState(toolInput, stateDir)) return { allow: true }

    const r = Axis.rung(rung)
    const coach =
      `You are at level ${contract.level} (${contract.label}), rung ${rung} (${r.name}). ${r.directive} ` +
      "Do not paste a code block for them to copy either — that is the same failure with extra steps."

    if (toolName === "Write") {
      const target = toolInput["file_path"]
      if (typeof target === "string" && target.length > 0) {
        return decideWrite(target, toolInput, contract, coach, shapeConfig)
      }
    }

    if (EDIT_ONLY_TOOLS.has(toolName)) {
      return {
        allow: false,
        rule: "edit-existing",
        reason:
          `LEVEL ${contract.level}: ${toolName} is blocked. It only applies to a file that already exists, and changing existing code is implementing — that half is the user's. ` +
          coach,
      }
    }

    if (WRITE_TOOLS.has(toolName)) {
      return {
        allow: false,
        rule: "write-tool",
        reason: `LEVEL ${contract.level}: ${toolName} is blocked. ` + coach,
      }
    }

    if (DELEGATION_TOOLS.has(toolName)) {
      return {
        allow: false,
        rule: "delegation",
        reason:
          `LEVEL ${contract.level}: delegating to a subagent is blocked — a subagent writing the code is the same as you writing it. ` +
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
            `LEVEL ${contract.level}: this Bash command writes to a file (${hit}), which is Write with extra steps. ` +
            "Running the user's tests, git, builds and linters is allowed and encouraged — authoring files is not. " +
            coach,
        }
      }
    }

    return { allow: true }
  }

  function decideWrite(
    target: string,
    toolInput: Record<string, unknown>,
    contract: Axis.GateContract,
    coach: string,
    shapeConfig: ShapeCheck.Config,
  ): Verdict {
    // LAYER 1 — create vs edit. Whether a file already exists is a fact,
    // which is the entire reason this is the boundary: "is this
    // boilerplate or the code that teaches them?" is a judgment call, and
    // a judgment call handed to the model is one its helpfulness gradient
    // widens until it swallows the feature.
    if (existsSync(target)) {
      return {
        allow: false,
        rule: "write:existing-file",
        reason:
          `LEVEL ${contract.level}: ${target} already exists, so writing it is an edit, and editing is implementing. ` +
          "Tell the user what needs to change in it and let them make the change. " +
          coach,
      }
    }

    if (!contract.mayCreateFiles) {
      return {
        allow: false,
        rule: "write:no-authorship",
        reason: `LEVEL ${contract.level}: you do not author files at this level. ` + coach,
      }
    }

    // LAYER 3 (checked before shape so an exhausted budget gives the
    // clearer message) — the daily cap.
    if (contract.remainingFiles !== null && contract.remainingFiles <= 0) {
      return {
        allow: false,
        rule: "write:budget-exhausted",
        reason:
          `LEVEL ${contract.level}: the daily budget for new files is spent. It resets tomorrow. ` +
          "Say so plainly with the count and move on — do not look for another way to put this on disk. " +
          coach,
      }
    }

    const content = typeof toolInput["content"] === "string" ? (toolInput["content"] as string) : ""
    const lines = countLines(content)
    if (lines > contract.maxLinesPerFile) {
      return {
        allow: false,
        rule: "write:too-many-lines",
        reason:
          `LEVEL ${contract.level}: ${lines} lines exceeds the ${contract.maxLinesPerFile}-line cap for a single new file. ` +
          "A scaffold is a skeleton, not an implementation — create the structure and leave the bodies for the user.",
      }
    }

    // LAYER 2 — shape. Markup has no bodies to leave empty, so an HTML or
    // JSON skeleton is legitimately all content and is judged by the line
    // cap alone.
    const allowance = contract.statementAllowance
    if (allowance !== null && ShapeCheck.classifyFile(target, shapeConfig) === "code") {
      // The language gates the loose rules (SQL DDL, Go's colon-less
      // struct fields). Derived from the target's extension, never from
      // the content, so it cannot be steered by what the agent writes.
      const lang = ShapeCheck.languageOf(target)
      const statements = ShapeCheck.countStatements(content, shapeConfig, lang)
      if (statements > allowance) {
        const samples = ShapeCheck.statementSamples(content, 3, shapeConfig, lang)
        const shown = samples.length > 0 ? ` Offending lines start with: ${samples.map((s) => `"${s}"`).join(", ")}.` : ""
        return {
          allow: false,
          rule: "write:shape",
          reason:
            `LEVEL ${contract.level}: this file has ${statements} executable statement(s); the limit for a new file at this level is ${allowance}. ` +
            "Create the SHAPE — imports, types, signatures, and a TODO in each body saying what it must do — and stop there. " +
            "The empty function the user has to fill is the entire point." +
            shown,
        }
      }
    }

    return { allow: true, rule: "write:create", chargedLines: lines }
  }
}

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function levelTable(): Axis.LevelTable | null {
  try {
    return (LEVELS_JSON as { levels?: Axis.LevelTable }).levels ?? null
  } catch {
    return null
  }
}

function shapeConfig(): ShapeCheck.Config {
  try {
    const sc = (LEVELS_JSON as { shape_check?: Record<string, unknown> }).shape_check
    if (!sc) return ShapeCheck.DEFAULT_CONFIG
    return {
      codeExtensions: (sc["code_extensions"] as string[]) ?? ShapeCheck.DEFAULT_CONFIG.codeExtensions,
      markupExtensions: (sc["markup_extensions"] as string[]) ?? ShapeCheck.DEFAULT_CONFIG.markupExtensions,
      markers: (sc["markers"] as string[]) ?? ShapeCheck.DEFAULT_CONFIG.markers,
    }
  } catch {
    return ShapeCheck.DEFAULT_CONFIG
  }
}

function maxLines(): number {
  const n = Number((LEVELS_JSON as { max_lines_per_new_file?: unknown }).max_lines_per_new_file)
  return Number.isFinite(n) && n > 0 ? n : 80
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

  const now = new Date()
  const table = levelTable()
  const level = Axis.readLevel(profile["global_level"])
  const budget = profile["axis_budget"] as Axis.Budget | undefined
  const escapes = profile["escapes"] as Axis.Escape[] | undefined

  const contract = Axis.gateContract(level, budget, escapes, now, maxLines(), table)

  // Disarmed by L1 (the agent is supposed to write), by the off ramp (the
  // axis is off), or by an open escape. All three are the same decision
  // from the axis's point of view, so they are one branch.
  if (!contract.armed) return

  const rung = Axis.clampRung(level, readRung(level), table)

  const verdict = Gate.decide({
    toolName,
    toolInput: input.tool_input ?? {},
    contract,
    rung,
    stateDir: stateDir(),
    shapeConfig: shapeConfig(),
  })

  if (verdict.allow) {
    if (verdict.chargedLines !== undefined) chargeBudget(verdict.chargedLines)
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
 * Charge one file against today's budget.
 *
 * This is the one place the gate writes state, so it takes the same
 * profile lock every other writer uses. Two caveats, both deliberate:
 *
 *  - It counts at ALLOW time, not at completion. If the write fails
 *    afterwards the budget is charged for a file that never landed. That
 *    error runs against the user, and closing the gap would mean a fourth
 *    hook firing on every tool call — not worth it for a rare case.
 *  - It is best-effort: if the bookkeeping throws, the write still goes
 *    through. A gate that blocks real work because it could not update a
 *    counter would be worse than one that miscounts.
 *
 * A DENIAL never charges. Being told no is not a use of the budget.
 */
function chargeBudget(lines: number): void {
  const p = join(stateDir(), "profile.json")
  try {
    StateIO.withLock(`${p}.lock`, () => {
      // Re-read inside the lock: build-context and record-turn mutate the
      // same file, and a stale copy would silently drop their writes.
      const fresh = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>
      const current = fresh["axis_budget"] as Axis.Budget | undefined
      fresh["axis_budget"] = Axis.chargeFile(current, new Date(), lines)
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
  return HintState.getInitialHintLevel(HintState.clampUserLevel(Axis.clampToAxis(level)))
}

main()
