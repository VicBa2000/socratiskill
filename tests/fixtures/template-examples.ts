/**
 * template-examples.ts — the template examples must survive the gate.
 *
 * WHY THIS EXISTS. rules/template.md tells the model what shape to hand
 * the user. gate-tool.ts decides what the model is actually allowed to
 * write. Nothing connected the two, and they disagreed on the first
 * draft: the documented template was an Express call expression with the
 * body left open, which is ONE executable statement — fine at level 1
 * (unlimited) and level 2 (8), denied at level 3, whose whole definition
 * is `statements_per_file: 0`.
 *
 * A model following the rule file at level 3 would have burned a turn on
 * a denial, and the user would have watched the plugin argue with itself.
 * The failure is invisible to every other test here: the rule file is
 * prose, the gate is code, and both were internally consistent.
 *
 * So each fenced example in template.md carries a marker:
 *
 *     <!-- gate-check: level 3, path src/routes/register.ts -->
 *
 * and this fixture runs the block that follows through the real gate at
 * that level. The file extension matters — shape-check derives the
 * language from it — so the path is part of the contract, not decoration.
 */

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const ROOT = join(import.meta.dir, "..", "..")
const RULES = join(ROOT, "skills", "socratic", "rules", "template.md")

let failures = 0
const fail = (msg: string) => { failures++; console.log(`  BROKEN  ${msg}`) }
const ok = (msg: string) => console.log(`  ok      ${msg}`)

interface Example {
  level: number
  path: string
  code: string
}

/** Every fenced block preceded by a `gate-check` marker. */
function parseExamples(md: string): Example[] {
  const out: Example[] = []
  const re = /<!--\s*gate-check:\s*level\s*(\d+)\s*,\s*path\s*([^\s>]+)\s*-->\s*\r?\n```[a-z]*\r?\n([\s\S]*?)```/g
  for (const m of md.matchAll(re)) {
    out.push({ level: Number(m[1]), path: m[2]!, code: m[3]! })
  }
  return out
}

/** Ask the real PreToolUse gate about a Write of `code` to `path`. */
function gateVerdict(stateDir: string, level: number, path: string, code: string): string | null {
  writeFileSync(
    join(stateDir, "profile.json"),
    JSON.stringify({ global_level: level, calibration_completed: true, enabled: true }, null, 2),
  )
  const input = JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: path, content: code },
    hook_event_name: "PreToolUse",
  })
  const res = spawnSync("bun", ["run", join(ROOT, "scripts", "gate-tool.ts")], {
    input,
    encoding: "utf-8",
    env: { ...process.env, SOCRATIC_STATE_DIR: stateDir },
  })
  const out = (res.stdout ?? "").trim()
  if (!out) return null // allow
  try {
    return JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string
  } catch {
    return out
  }
}

const md = readFileSync(RULES, "utf-8")
const examples = parseExamples(md)

if (examples.length < 2) {
  fail(`expected at least 2 gate-checked examples in template.md, found ${examples.length}`)
} else {
  ok(`found ${examples.length} gate-checked examples`)
}

const stateDir = mkdtempSync(join(tmpdir(), "tmplcheck-"))

for (const ex of examples) {
  const reason = gateVerdict(stateDir, ex.level, ex.path, ex.code)
  if (reason === null) {
    ok(`the level-${ex.level} example is allowed at level ${ex.level} (${ex.path})`)
  } else {
    fail(`the level-${ex.level} example is DENIED at level ${ex.level}: ${reason.slice(0, 120)}`)
  }
}

// The two forms must not be interchangeable, or the distinction the rule
// file draws is decoration. The permissive form has to actually fail at
// the strict level — that is the whole reason there are two.
const permissive = examples.find((e) => e.level === 1)
const strict = examples.find((e) => e.level === 3)

if (permissive && strict) {
  const reason = gateVerdict(stateDir, 3, permissive.path, permissive.code)
  if (reason === null) {
    fail(
      "the level-1 example passes at level 3 too — then template.md is drawing a distinction that does not exist, " +
        "or the level-3 statement budget stopped being 0",
    )
  } else {
    ok("the level-1 form is genuinely denied at level 3 (the distinction is real)")
  }
} else {
  fail("template.md must keep one level-1 example and one level-3 example")
}

console.log("")
console.log(
  failures === 0
    ? "template examples: the documented shapes are writable at their levels"
    : `template examples: ${failures} contract(s) broken`,
)
process.exit(failures === 0 ? 0 : 1)
