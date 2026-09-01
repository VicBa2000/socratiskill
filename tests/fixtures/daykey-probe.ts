/** Prints Axis.dayKey(now) so the harness can compare it with `date -u`. */
import { Axis } from "../../scripts/axis-state"
process.stdout.write(Axis.dayKey(new Date()))
