/**
 * Behavioral checks for the axis contract, emitted as `name=OK|BAD` lines
 * so the bash harness can assert each one separately.
 *
 * These live in a fixture rather than in `bun -e` inside the harness
 * because bun does not resolve MSYS-style paths (/c/...) inside an import
 * string, and $SCRIPTS is exactly that in Git Bash.
 */
import { Axis } from "../../scripts/axis-state"

const out: string[] = []
const check = (name: string, cond: boolean) => out.push(`${name}=${cond ? "OK" : "BAD"}`)

// R6.1 — no automatic path may land on the off ramp.
check("clamp", [6, 7, 99].every((n) => Axis.clampToAxis(n) === 5) && Axis.clampToAxis(0) === 1)

// readLevel PRESERVES 6, unlike every v4 reader's min(5,...).
check(
  "readlevel",
  Axis.readLevel(6) === 6 && Axis.readLevel(3) === 3 && Axis.readLevel(0) === 1 &&
    Axis.readLevel(9) === 3 && Axis.readLevel(undefined) === 3,
)

// Authorship contract, straight off levels.json.
check(
  "authorship",
  [1, 2, 3, 4, 5, 6].map((n) => Axis.mayEditExisting(n)).join(",") === "true,false,false,false,false,true" &&
    [1, 2, 3, 4, 5].map((n) => String(Axis.statementAllowance(n))).join(",") === "null,8,0,0,0",
)

// The level bounds the ladder; the rung moves inside it.
check(
  "rung",
  Axis.clampRung(5, 4) === 1 && Axis.clampRung(3, 0) === 3 &&
    Axis.clampRung(3, 4) === 4 && Axis.clampRung(6, 4) === 4,
)

// Daily budget, keyed by UTC — the suite has been bitten by local dates before.
{
  const now = new Date("2026-08-31T22:00:00.000Z")
  const next = new Date("2026-09-01T01:00:00.000Z")
  let b = Axis.freshBudget(now)
  b = Axis.chargeFile(b, now, 40)
  b = Axis.chargeFile(b, now, 10)
  check(
    "budget",
    b.date === "2026-08-31" && b.files_used === 2 && b.lines_written === 50 &&
      Axis.remainingFiles(3, b, now) === 4 && Axis.remainingFiles(1, b, now) === null &&
      Axis.currentBudget(b, next).files_used === 0,
  )
}

// The three fail-open paths: L1, the off ramp, and an open escape.
{
  const now = new Date("2026-08-31T22:00:00.000Z")
  const esc = [Axis.createEscape(now, "prod incident", 10)]
  const armed = (l: number, e: Axis.Escape[]) => Axis.gateContract(l, null, e, now, 80).armed
  check(
    "failopen",
    armed(3, []) && !armed(1, []) && !armed(6, []) && !armed(3, esc) &&
      !Axis.isEscapeActive(esc, new Date(now.getTime() + 11 * 60_000)),
  )
}

console.log(out.join("\n"))
process.exit(out.some((l) => l.endsWith("=BAD")) ? 1 : 0)
