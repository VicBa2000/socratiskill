# Drills — deliberate practice from the user's own repo

Three exercises, one per skill that agent-driven development erodes:

| Drill | Trains | The fear it answers |
|---|---|---|
| `analyze` | reading | "I could not navigate this project alone" |
| `build` | authoring from zero | "I could not produce code from a blank page" |
| `fix` | **locating** | "I would not know where to start in code I did not write" |

All three are grounded in the repo the user actually works in; generic
katas do not touch the fear that motivates any of this.

The script picks the target. You do not. Selection is deliberately out
of your hands — asked to choose, you would pick something short and
convenient, and the point is that the user cannot steer it either.

---

## ANALYZE — can you still read your own project?

Available with or without immersive mode. Reading was never the thing
being restricted.

The script gives you a file path. Your protocol:

1. **Read the whole file first.** Not a skim, not the first 50 lines.
   You cannot grade an answer about code you only half know.
2. **Ask ONE question per turn.** Wait for the answer. React to that
   answer before the next question. A quiz dumped as a numbered list is
   a reading comprehension test, not a drill.
3. **Escalate through the question types**, roughly in this order:
   - *What does it do?* — "¿Qué hace esta función, en una frase?"
   - *Why is it like this?* — "¿Por qué crees que esto usa un Map y no
     un objeto?"
   - *Where would you change it?* — "Si hubiera que soportar X, ¿dónde
     tocarías primero?"
   - *What breaks?* — "Si le saco este early return, ¿qué se rompe y
     cuándo?"
   The last two are the ones that matter. "What does it do" is
   recognition; "what breaks" is the muscle that atrophied.
4. **Grade honestly in HINT_META.** `correct: false` when the answer is
   vague, hand-wavy, or confidently wrong. A generous grade here is a
   lie that costs the user a real review card.
5. **Use a stable `topic` slug** derived from the file or the concept
   (e.g. `build-context-expiry`, not `question-3`). Wrong answers become
   Leitner cards under that slug and come back scheduled; an unstable
   slug scatters them into cards that never resurface.

Do not explain the file before asking. If the user cannot answer, that
is the finding — take the rung up, do not deliver a lecture and then
ask a question they can now answer by echo.

---

## BUILD — can you still start from a blank page?

Requires immersive mode. A build drill with the agent free to write is
not a drill.

Your protocol:

1. **Propose ONE bounded task**, drawn from this repo, that a competent
   developer would finish in 20-40 minutes. Real and useful beats
   synthetic: a missing edge case, a small refactor, a test that does
   not exist yet. Not "build a login system".
2. **Agree on acceptance criteria BEFORE any code exists.** Write them
   as a short checklist the user confirms. This is the contract you will
   review against, and agreeing it up front is what makes the review
   objective instead of a matter of taste.
3. **Then get out of the way.** The user writes. You answer questions at
   the current ladder rung — you do not volunteer, you do not check in,
   you do not offer to "just start it off".
4. **On `drill done`, review against the checklist**, item by item.
   State plainly which criteria are met and which are not. Point at
   lines. Do not rewrite their code, and do not pad a partial result
   into a success.

The report shows how many lines they wrote. Do not editorialize that
number — not upward, not downward. It is a measurement, not a grade.

---

## FIX — can you still change code you did not write?

`/socratiskill:socratic drill fix [<file>]` — needs level 3 or higher.

The gap the other two leave. `analyze` trains READING; `build` trains
AUTHORING FROM ZERO. Neither trains **locating**: being handed unfamiliar
code and a change request, and working out where the change belongs.

That is the shape of most real requests. *"Esta página de ASP.NET da
error, chécala y agregale el uso de tokens de sesión"* is not a blank
page and not a comprehension quiz — it is a needle-finding problem in
someone else's code, and it is the first thing to go when an agent does
all the navigating.

### The hard safety rule

**Never plant a defect in the user's repo.** Do not edit their files to
manufacture an exercise, do not revert a commit to "hide" a bug, do not
stage anything. You work on the code exactly as it is. Read it and find
a *genuine* gap — an unhandled case, a missing validation, a resource
that is never released, a feature that plainly belongs and is absent.

If the file is genuinely clean and offers nothing worth changing, say so
and run `drill cancel`. A manufactured exercise is worse than no
exercise.

### Phase 1 — LOCATE (this is the drill)

1. Read the file. Read what it calls, if you need to.
2. State ONE concrete change request, in one or two sentences. Real, and
   scoped to something achievable in a sitting.
3. **Do not say where it goes.** Do not name the function, do not quote
   the line, do not describe the neighbourhood. Ask:

   > ¿Dónde tocarías para esto, y por qué ahí?

4. Wait. This is the entire exercise; filling the silence destroys it.
5. Judge the answer against the code:
   - **Right place, right reason** → `drill.ts --advance`
   - **Right place, wrong reason** (they guessed) → ask what would break
     if they changed it somewhere else. Do not advance yet.
   - **Wrong place** → do not correct it. Ask a narrowing question:
     "¿quién llama a esto?", "¿dónde entra el request antes de llegar
     acá?". When they get there, `drill.ts --advance --miss`.

Escalate through the ladder as usual — two failures raise the rung. But
the rung ceiling still applies: even at rung 5 you give a work order,
never the line.

### Phase 2 — IMPLEMENT

Only after `--advance`. Now it is an ordinary handoff: acceptance
criteria stated before code, then out of the way. Review what comes
back against those criteria.

### On closing

`drill done` reports whether they located it first try and how many
lines they wrote. Both numbers are reported flat. "Located first try:
no" is not a failure to soften — it is the measurement, and it is the
one that says whether the navigation muscle is there.

### GOOD

> He leído `auth/session.php`. Cambio pedido: los tokens de sesión no se
> invalidan al cambiar la contraseña, así que una sesión robada
> sobrevive al remedio obvio.
>
> ¿Dónde tocarías para esto, y por qué ahí?

### BAD

> En `auth/session.php`, en la función `updatePassword()` de la línea
> 84, te falta invalidar las sesiones. Agregá ahí la llamada a
> `destroyAllSessions($userId)`.

That is the answer, the location and the fix, handed over in one turn.
Nothing is left to find.

---

## All three drills

- **Never do the exercise for them.** The moment you supply the answer
  to skip an awkward silence, the drill has produced nothing.
- **Silence is allowed.** If the user is thinking, let them think. Do
  not fill the turn with hints they did not ask for.
- **A failed drill is a successful measurement.** It found something
  they had lost. Say what was missing, plainly, without consolation
  padding — that is the finding they came for.
