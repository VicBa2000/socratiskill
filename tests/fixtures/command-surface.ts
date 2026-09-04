/**
 * command-surface.ts — the documentation contract.
 *
 * WHY THIS EXISTS. Three separate bugs of the SAME SHAPE shipped in a
 * row, and no assert saw any of them, because every test in the suite
 * exercises BEHAVIOUR and these were defects in the HELP TEXT:
 *
 *   1. The end-of-calibration message told the user to run
 *      `mode productive`. That subcommand was deleted in the v0.5.0
 *      unification — migrate-profile.ts actively strips the field — so
 *      it landed on "unknown subcommand", in the first minute of every
 *      new user's life.
 *   2. The "valid:" list printed on a typo said
 *      `drill [analyze|build|done]`: no `fix` (the whole point of
 *      v0.5.1), no `status`, no `cancel`. The one place a user sees the
 *      list showed an incomplete one.
 *   3. `ship <reason> [minutes]` appeared in four places, but the parser
 *      only reads the minutes when they come FIRST. The form the error
 *      message itself recommended silently swallowed the number into the
 *      reason and left the duration at the default.
 *
 * The common shape: help text that kept describing behaviour that had
 * stopped existing. This file is the guard for that shape.
 *
 * WHY IT CLOSES TO CODE, NOT JUST DOC-TO-DOC. Checking the three lists
 * against each other would have caught (2) and nothing else — and it
 * passes happily when all three are wrong together, which is exactly
 * what happened with `mode`. So the drill surface is derived from
 * drill.ts, and the retired-concept scan looks for things the code no
 * longer implements at all.
 *
 * SELF-MATCH NOTE. This file necessarily CONTAINS the retired words it
 * searches for. It scans `skills/` and `hooks/` only, never `tests/`,
 * so it cannot match its own source. A self-match would make the check
 * fail forever and teach whoever inherits it to delete it — the same
 * trap S34 documents for its date pattern.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")
const SKILL = join(ROOT, "skills", "socratic", "SKILL.md")

let failures = 0
const fail = (msg: string) => { failures++; console.log(`  BROKEN  ${msg}`) }
const ok = (msg: string) => console.log(`  ok      ${msg}`)

const skill = readFileSync(SKILL, "utf-8")

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

/** First word of a token like "level <1-5>" or "analyze <file>". */
const head = (s: string): string => (s.trim().match(/^[a-z]+/i)?.[0] ?? "").toLowerCase()

const setOf = (xs: string[]): Set<string> => new Set(xs.filter(Boolean))

const diff = (a: Set<string>, b: Set<string>): string[] =>
  [...a].filter((x) => !b.has(x)).sort()

/**
 * Split on top-level `|` only. Splitting naively would tear
 * `journal [today|week|month]` into three phantom top-level commands and
 * `drill [analyze | build | ...]` into six more, which is how a first
 * draft of this check reported nineteen fictional mismatches.
 */
function pipeList(raw: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ""
  for (const c of raw) {
    if (c === "[" || c === "<") depth++
    else if (c === "]" || c === ">") depth = Math.max(0, depth - 1)
    if (c === "|" && depth === 0) { parts.push(cur); cur = ""; continue }
    cur += c
  }
  parts.push(cur)
  return parts.map(head).filter(Boolean)
}

/** The bracketed sub-list of a command, e.g. drill [a | b | c]. */
function bracketOf(raw: string, cmd: string): string[] {
  // Tolerates nesting: `drill [analyze [<file>] | build]`.
  const at = raw.indexOf(cmd)
  if (at < 0) return []
  const open = raw.indexOf("[", at)
  if (open < 0) return []
  let depth = 0
  for (let i = open; i < raw.length; i++) {
    if (raw[i] === "[") depth++
    else if (raw[i] === "]") {
      depth--
      if (depth === 0) return pipeList(raw.slice(open + 1, i))
    }
  }
  return []
}

// --------------------------------------------------------------------
// 1. The three documented lists must agree on the top-level commands.
// --------------------------------------------------------------------

const hintLine = /^argument-hint:\s*"\[(.*)\]"\s*$/m.exec(skill)?.[1] ?? ""
if (!hintLine) fail("argument-hint not found in the frontmatter")

const validLine = /^valid:\s*(.*)$/m.exec(skill)?.[1] ?? ""
if (!validLine) fail('the "valid:" fallback list was not found')

/**
 * What the dispatcher actually handles: every bullet in `## Subcommands`,
 * reading the backticked tokens that appear before the `->`.
 */
function dispatcherCommands(): Set<string> {
  const body = skill.slice(skill.indexOf("## Subcommands"))
  // Anchored to a line start: the same words appear mid-sentence inside
  // the `level` bullet ("...commenting on the choice. For anything
  // else, respond `invalid level`"), and an unanchored search cuts the
  // section there, silently hiding every bullet after it.
  const end = body.search(/^For anything else/m)
  const section = end > 0 ? body.slice(0, end) : body
  const out: string[] = []
  for (const line of section.split("\n")) {
    if (!line.startsWith("- ")) continue
    const arrow = line.indexOf("->")
    const lhs = arrow > 0 ? line.slice(0, arrow) : line
    for (const m of lhs.matchAll(/`([^`]+)`/g)) out.push(head(m[1]!))
  }
  return setOf(out)
}

const hint = setOf(pipeList(hintLine))
const valid = setOf(pipeList(validLine))
const dispatch = dispatcherCommands()

for (const [name, s] of [["argument-hint", hint], ["valid: list", valid]] as const) {
  const missing = diff(dispatch, s)
  const extra = diff(s, dispatch)
  if (missing.length === 0 && extra.length === 0) {
    ok(`${name} matches the dispatcher (${s.size} commands)`)
  } else {
    if (missing.length) fail(`${name} is missing: ${missing.join(", ")}`)
    if (extra.length) fail(`${name} promises commands the dispatcher lacks: ${extra.join(", ")}`)
  }
}

// --------------------------------------------------------------------
// 2. The drill surface must match drill.ts — the doc-to-CODE half.
//    Bug (2) lived here, and a doc-to-doc check would have passed once
//    all three lists agreed on the same wrong answer.
// --------------------------------------------------------------------

const drillSrc = readFileSync(join(ROOT, "scripts", "drill.ts"), "utf-8")

// The `--kind` values the script accepts.
const kinds = setOf(
  [...drillSrc.matchAll(/"(analyze|build|fix)"/g)].map((m) => m[1]!),
)
// The lifecycle flags a USER drives. --advance/--miss are the model's to
// call mid-drill, so they are deliberately not user subcommands.
const lifecycle = setOf(
  [...drillSrc.matchAll(/"--(status|done|cancel)"/g)].map((m) => m[1]!),
)
const realDrill = setOf([...kinds, ...lifecycle])

const drillIn = {
  "argument-hint": setOf(bracketOf(hintLine, "drill")),
  "valid: list": setOf(bracketOf(validLine, "drill")),
  "dispatcher bullet": setOf(
    bracketOf(
      skill.split("\n").find((l) => l.startsWith("- `drill ")) ?? "",
      "drill",
    ),
  ),
}

for (const [name, s] of Object.entries(drillIn)) {
  const missing = diff(realDrill, s)
  const extra = diff(s, realDrill)
  if (missing.length === 0 && extra.length === 0) {
    ok(`drill surface in ${name} matches drill.ts (${[...realDrill].sort().join(", ")})`)
  } else {
    if (missing.length) fail(`drill surface in ${name} omits: ${missing.join(", ")}`)
    if (extra.length) fail(`drill surface in ${name} invents: ${extra.join(", ")}`)
  }
}

// --------------------------------------------------------------------
// 3. Retired vocabulary must not survive in live instruction files.
//    Bug (1) and bug (3) were both this: text describing behaviour the
//    code no longer has.
// --------------------------------------------------------------------

interface Banned {
  pattern: RegExp
  why: string
  roots: string[]
}

const BANNED: Banned[] = [
  {
    pattern: /\bimmersive\b/i,
    why: "immersive mode was folded into the axis in v0.5.0",
    roots: ["skills", "hooks"],
  },
  {
    pattern: /\bmode\s+(productive|learn)\b/i,
    why: "the learn/productive dial was removed in v0.5.0; the level is the only dial",
    roots: ["skills", "hooks"],
  },
  {
    pattern: /\bunlock\b/i,
    why: "`unlock` became `ship` in v0.5.0",
    roots: ["skills", "hooks"],
  },
  {
    // v0.4 had a user-granted "scaffold window", retired in v0.5.0 —
    // migrate-profile.ts still tells upgrading users it disappeared. The
    // delivery mode added later ("pasame la plantilla, yo codifico") was
    // first drafted under that same name, which would have shipped a
    // subcommand whose name the migration notice calls dead. It is
    // `template` for that reason. Note \b does not match "scaffolding",
    // so axis.md's "worth scaffolding" wording stays legal.
    pattern: /\bscaffold\b/i,
    why: "the v0.4 scaffold window was retired in v0.5.0; the delivery mode is `template`",
    roots: ["skills", "hooks"],
  },
  {
    pattern: /ship\s+<reason>\s*\[minutes\]/i,
    why: "the minutes come FIRST; this form silently swallows the number into the reason",
    roots: ["skills", "README.md", "QUICKSTART.txt", "MANUAL-TEST.md"],
  },
  {
    // Both CLAUDE.md and sistemas.txt described this script, and the
    // SessionStart hook that would run it, in enough detail to be
    // believed. Neither ever existed. The manifest registers exactly
    // three events. Banning the FILENAME rather than the word lets the
    // reference keep explaining that the hook is absent.
    pattern: /hook-session-start/i,
    why: "there is no SessionStart hook; the manifest registers UserPromptSubmit, PreToolUse and Stop",
    roots: ["skills", "hooks", "README.md", "QUICKSTART.txt", "MANUAL-TEST.md", "sistemas.txt"],
  },
]

function walk(p: string, out: string[] = []): string[] {
  let st
  try { st = statSync(p) } catch { return out }
  if (st.isFile()) { out.push(p); return out }
  if (!st.isDirectory()) return out
  for (const e of readdirSync(p)) walk(join(p, e), out)
  return out
}

for (const b of BANNED) {
  const hits: string[] = []
  for (const root of b.roots) {
    for (const f of walk(join(ROOT, root))) {
      if (!/\.(md|txt|json|sh|ts)$/i.test(f)) continue
      let txt = ""
      try { txt = readFileSync(f, "utf-8") } catch { continue }
      txt.split("\n").forEach((line, i) => {
        if (b.pattern.test(line)) {
          hits.push(`${f.slice(ROOT.length + 1).replace(/\\/g, "/")}:${i + 1}`)
        }
      })
    }
  }
  if (hits.length === 0) {
    ok(`no live text says ${b.pattern.source.slice(0, 28)}… (${b.why})`)
  } else {
    fail(`retired vocabulary still live at ${hits.slice(0, 4).join(", ")} — ${b.why}`)
  }
}

// --------------------------------------------------------------------

console.log("")
console.log(
  failures === 0
    ? "command surface: docs agree with each other and with the code"
    : `command surface: ${failures} contract(s) broken`,
)
process.exit(failures === 0 ? 0 : 1)
