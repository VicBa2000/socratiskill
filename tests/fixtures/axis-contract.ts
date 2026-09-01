/**
 * Asserts that data/levels.json and Axis.FALLBACK agree field by field.
 *
 * The JSON is the tunable source of truth; the FALLBACK is what runs when
 * the JSON is missing or corrupt. A drift between them would only surface
 * on a broken install, which is the worst time to discover it — so it is
 * checked on every suite run instead.
 *
 * Exit 0 = they agree.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Axis } from "../../scripts/axis-state"

const here = dirname(fileURLToPath(import.meta.url))
const raw = JSON.parse(readFileSync(join(here, "..", "..", "data", "levels.json"), "utf8"))
const table = raw.levels as Record<string, Axis.LevelSpec>

const FIELDS: (keyof Axis.LevelSpec)[] = [
  "key", "authorship", "files_per_day", "statements_per_file",
  "may_edit_existing", "rung_min", "rung_max", "handoff",
]

let bad = 0
for (const k of ["1", "2", "3", "4", "5", "6"]) {
  const a = table[k]
  const b = Axis.FALLBACK[k]
  if (!a || !b) { console.error(`level ${k} missing`); bad++; continue }
  for (const f of FIELDS) {
    if (a[f] !== b[f]) { console.error(`level ${k}.${f}: json=${a[f]} fallback=${b[f]}`); bad++ }
  }
}
process.exit(bad === 0 ? 0 : 1)
