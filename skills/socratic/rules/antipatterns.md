# Antipatterns (soft interceptor)

When `SOCRATIC CONTEXT` includes a line
`active antipatterns: <id>(N), <id>(N)`, each id in that list is a
pattern the user (or you) has already repeated >=3 times. The goal:
stop emitting further occurrences silently, and flag them explicitly
when they show up.

## What to do when antipatterns are active

1. **Before writing code** (your own or when editing the user's): check
   whether the snippet would introduce any active `id`. If yes, rewrite
   BEFORE emitting and **explain why** to the user.
2. **When reading the user's code**: if their code contains an active
   antipattern, interrupt before building on top of it. Example:
   "before we continue, I notice you are still using `==` (3rd time
   this session). Let's switch to `===` first."
3. If an antipattern stays active and the user insists on using it
   (e.g. "I'm aware of the difference and prefer it"), accept with a
   protest: one sentence acknowledging the decision, but do not
   normalize it.

## Antipattern table (live definitions in data/antipatterns.json)

| id                    | lang | Severity | Detects                                      |
|-----------------------|------|----------|----------------------------------------------|
| js-loose-eq           | JS   | medium   | `==` / `!=` (vs `===` / `!==`)               |
| js-var                | JS   | low      | `var x =` declarations                       |
| js-unhandled-promise  | JS   | high     | `.then(...)` without `.catch(...)`           |
| py-mutable-default    | PY   | high     | `def f(x=[])` mutable default argument       |
| py-bare-except        | PY   | medium   | `except:` without exception type             |

## Honest limitation (difference vs SocraticCode fork)

The OpenCode fork can intercept `Write`/`Edit` tool calls at the
binary level and **block** code that contains antipatterns before it
hits disk. Claude Code **does not expose that hook**.

This skill can therefore only:
- Detect post-hoc (the Stop hook scans emitted code).
- Inject an instruction into SOCRATIC CONTEXT asking the model to
  self-censor on the next turn.

Enforcement is soft. If the model ignores the instruction, the
antipattern escapes to the file. The mechanism works while Opus
obeys the hook's stdout (observed consistently across testing).
Real mitigation for the user: review the diff before committing.

## Thresholds (defined in data/antipatterns.json)

- **activation_threshold: 3** — activates when occurrences accumulate
  to 3 in total (not necessarily 3 in the same turn).
- **deactivation_clean_streak: 5** — after activation, deactivates
  once 5 consecutive turns pass with no matches. `occurrence_count`
  is NOT reset on deactivation (history is preserved).
