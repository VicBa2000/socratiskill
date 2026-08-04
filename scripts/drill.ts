/**
 * drill.ts — deliberate practice exercises drawn from the user's own repo.
 *
 * Two kinds, aimed at the two halves of the atrophy:
 *
 *   analyze — the user is interrogated about code that already exists.
 *             Targets "I could not navigate a project without an agent".
 *             Works with or without immersive mode; reading is not the
 *             thing being restricted.
 *
 *   build   — the user implements a bounded task from a blank page.
 *             Targets "I could not produce code from scratch". Requires
 *             immersive mode, because a build drill with the agent free
 *             to write is not a drill.
 *
 * This script owns SELECTION and STATE; the model owns the pedagogy.
 * Selection is deterministic on purpose: asked to choose a file to be
 * quizzed on, a model reliably picks something short and convenient, and
 * a rotation the user cannot game is worth more than a smart pick.
 *
 * CLI: bun run drill.ts --kind analyze [--file <path>]
 *      bun run drill.ts --kind build
 *      bun run drill.ts --status
 *      bun run drill.ts --done | --cancel
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join, relative, extname, sep } from "node:path"
import { Immersive } from "./immersive-state"
import { ImmersiveReport } from "./immersive-report"
import { StateIO } from "./state-io"

interface Args {
  kind?: string
  file?: string
  status?: boolean
  done?: boolean
  cancel?: boolean
}

interface DrillState {
  kind: "analyze" | "build"
  file: string | null
  started_at: string
  git_baseline?: ImmersiveReport.GitBaseline | null
}

interface DrillHistoryEntry {
  file: string
  kind: string
  at: string
}

const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".kt", ".scala",
  ".sh", ".bash", ".sql", ".vue", ".svelte",
])

/**
 * Excluded from selection: not code the user authored, or not code whose
 * comprehension says anything about their grasp of the project.
 */
const EXCLUDE_DIR = [
  "node_modules", "dist", "build", "out", "target", "vendor",
  ".git", "coverage", "__pycache__", ".next", ".nuxt", "migrations",
]
const EXCLUDE_NAME = /\.(min|bundle|generated|gen|lock|d)\.[a-z]+$|^package-lock|^yarn\.lock|^bun\.lockb/i

/** Files this small teach nothing; this large are a slog, not a drill. */
const MIN_LINES = 25
const MAX_LINES = 500

/** How many recent drills to avoid repeating. */
const ROTATION_WINDOW = 10

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    if (a === "--kind" && v !== undefined) { out.kind = v; i++ }
    else if (a === "--file" && v !== undefined) { out.file = v; i++ }
    else if (a === "--status") out.status = true
    else if (a === "--done") out.done = true
    else if (a === "--cancel") out.cancel = true
  }
  return out
}

function stateDir(): string {
  return process.env["SOCRATIC_STATE_DIR"] ?? join(homedir(), ".claude", "socratic")
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function sessionPath(): string {
  return join(stateDir(), "sessions", `${todayIso()}.json`)
}

function historyPath(): string {
  return join(stateDir(), "drills.json")
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return fallback
  }
}

function readProfile(): Record<string, unknown> {
  return readJson<Record<string, unknown>>(join(stateDir(), "profile.json"), {})
}

function readDrill(): DrillState | null {
  const doc = readJson<{ drill?: DrillState }>(sessionPath(), {})
  return doc.drill ?? null
}

function writeDrill(drill: DrillState | null): void {
  const p = sessionPath()
  StateIO.withLock(`${p}.lock`, () => {
    const doc = readJson<Record<string, unknown>>(p, { date: todayIso(), turns: [] })
    if (drill === null) delete doc["drill"]
    else doc["drill"] = drill
    StateIO.writeJsonAtomic(p, doc)
  })
}

function readHistory(): DrillHistoryEntry[] {
  const h = readJson<{ history?: DrillHistoryEntry[] }>(historyPath(), {})
  return Array.isArray(h.history) ? h.history : []
}

function pushHistory(entry: DrillHistoryEntry): void {
  const p = historyPath()
  try {
    StateIO.withLock(`${p}.lock`, () => {
      const h = readJson<{ history?: DrillHistoryEntry[] }>(p, {})
      const history = Array.isArray(h.history) ? h.history : []
      history.push(entry)
      StateIO.writeJsonAtomic(p, { history: history.slice(-200) })
    })
  } catch {
    // History only drives rotation; losing it is not worth failing on.
  }
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

/** Tracked files if this is a repo; otherwise a bounded directory walk. */
function candidateFiles(root: string): string[] {
  const tracked = git(["ls-files"], root)
  if (tracked) return tracked.split("\n").filter((s) => s.length > 0)

  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length > 3000) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (EXCLUDE_DIR.includes(name)) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, depth + 1)
      else out.push(relative(root, full).split(sep).join("/"))
    }
  }
  walk(root, 0)
  return out
}

function isDrillable(path: string): boolean {
  if (!SOURCE_EXT.has(extname(path).toLowerCase())) return false
  const parts = path.split("/")
  if (parts.some((p) => EXCLUDE_DIR.includes(p))) return false
  const base = parts[parts.length - 1] ?? ""
  if (EXCLUDE_NAME.test(base)) return false
  return true
}

function countLines(full: string): number {
  try {
    const raw = readFileSync(full, "utf-8")
    if (raw.indexOf("\0") !== -1) return 0
    if (raw.length === 0) return 0
    // A trailing newline terminates the last line, it does not start a
    // new one — splitting naively would report every well-formed file as
    // one line longer than it is.
    const n = raw.split("\n").length
    return raw.endsWith("\n") ? n - 1 : n
  } catch {
    return 0
  }
}

/**
 * Pick a file to be quizzed on: drillable size, not drilled recently.
 * Rotation beats cleverness — the point is that the user cannot predict
 * or steer which file comes up.
 */
function selectFile(root: string): { file: string; lines: number } | null {
  const recent = new Set(
    readHistory().slice(-ROTATION_WINDOW).map((h) => h.file),
  )

  const pool = candidateFiles(root).filter(isDrillable)
  const sized: Array<{ file: string; lines: number }> = []
  for (const f of pool.slice(0, 400)) {
    const lines = countLines(join(root, f))
    if (lines >= MIN_LINES && lines <= MAX_LINES) sized.push({ file: f, lines })
  }
  if (sized.length === 0) return null

  const fresh = sized.filter((s) => !recent.has(s.file))
  const from = fresh.length > 0 ? fresh : sized
  return from[Math.floor(Math.random() * from.length)] ?? null
}

function requireNoActiveDrill(): void {
  const active = readDrill()
  if (active) {
    process.stderr.write(
      `error: a ${active.kind} drill is already running (started ${active.started_at}).\n` +
        "close it with /socratiskill:socratic drill done, or drop it with drill cancel.\n",
    )
    process.exit(2)
  }
}

function cmdAnalyze(args: Args): void {
  requireNoActiveDrill()
  const root = ImmersiveReport.repoRoot(process.cwd()) ?? process.cwd()

  let file: string
  let lines: number
  if (args.file) {
    file = args.file.split(sep).join("/")
    const full = join(root, file)
    if (!existsSync(full)) {
      process.stderr.write(`error: file not found: ${file}\n`)
      process.exit(2)
    }
    lines = countLines(full)
  } else {
    const picked = selectFile(root)
    if (!picked) {
      process.stderr.write(
        "error: found no drillable source file here.\n" +
          `looked for tracked source files between ${MIN_LINES} and ${MAX_LINES} lines.\n` +
          "pass one explicitly: /socratiskill:socratic drill analyze <path>\n",
      )
      process.exit(2)
    }
    file = picked.file
    lines = picked.lines
  }

  const drill: DrillState = { kind: "analyze", file, started_at: new Date().toISOString() }
  writeDrill(drill)
  pushHistory({ file, kind: "analyze", at: drill.started_at })

  process.stdout.write(
    [
      "drill started: analyze",
      `file: ${file}`,
      `lines: ${lines}`,
      `root: ${root}`,
      "protocol: read the file, then ask ONE question at a time. See rules/drills.md.",
    ].join("\n") + "\n",
  )
}

function cmdBuild(): void {
  requireNoActiveDrill()

  const profile = readProfile()
  const immersive = Immersive.isState(profile["immersive"]) ? profile["immersive"] : null
  if (!Immersive.isActive(immersive, new Date())) {
    process.stderr.write(
      "error: a build drill needs immersive mode — otherwise the agent can just write it for you.\n" +
        "start one first: /socratiskill:socratic immersive 45\n",
    )
    process.exit(2)
  }

  const root = ImmersiveReport.repoRoot(process.cwd()) ?? process.cwd()
  const drill: DrillState = {
    kind: "build",
    file: null,
    started_at: new Date().toISOString(),
    git_baseline: ImmersiveReport.captureBaseline(process.cwd()),
  }
  writeDrill(drill)

  process.stdout.write(
    [
      "drill started: build",
      `root: ${root}`,
      drill.git_baseline ? "measuring: yes (git)" : "measuring: no (not a git repo)",
      "protocol: propose ONE bounded task from this repo, agree on acceptance criteria BEFORE any code, then stay out of the way. See rules/drills.md.",
    ].join("\n") + "\n",
  )
}

function cmdStatus(): void {
  const drill = readDrill()
  if (!drill) {
    process.stdout.write("drill: none active\n")
    return
  }
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(drill.started_at)) / 60000))
  process.stdout.write(
    [
      `drill: ${drill.kind}`,
      drill.file ? `file: ${drill.file}` : "file: (n/a)",
      `elapsed: ${mins} min`,
    ].join("\n") + "\n",
  )
}

function cmdDone(): void {
  const drill = readDrill()
  if (!drill) {
    process.stderr.write("error: no drill is running.\n")
    process.exit(2)
  }

  const now = new Date()
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(drill.started_at)) / 60000))
  const out: string[] = [`drill finished: ${drill.kind}`, `duration: ${mins} min`]

  if (drill.kind === "build" && drill.git_baseline) {
    const lines = ImmersiveReport.linesSinceBaseline(drill.git_baseline)
    out.push(
      lines
        ? `you wrote: +${lines.added} / -${lines.removed} lines`
        : "you wrote: (could not measure)",
    )
  }
  if (drill.file) out.push(`file: ${drill.file}`)
  out.push("protocol: now review against the acceptance criteria agreed at the start. See rules/drills.md.")

  writeDrill(null)
  process.stdout.write(out.join("\n") + "\n")
}

function cmdCancel(): void {
  const drill = readDrill()
  if (!drill) {
    process.stdout.write("drill: none active\n")
    return
  }
  writeDrill(null)
  process.stdout.write(`drill cancelled: ${drill.kind}\n`)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.status) return cmdStatus()
  if (args.done) return cmdDone()
  if (args.cancel) return cmdCancel()
  if (args.kind === "analyze") return cmdAnalyze(args)
  if (args.kind === "build") return cmdBuild()
  process.stderr.write("error: expected --kind analyze [--file <path>] | --kind build | --status | --done | --cancel\n")
  process.exit(2)
}

main()
