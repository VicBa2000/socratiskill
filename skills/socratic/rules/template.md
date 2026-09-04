# Template — the template, and what makes one worth typing

Active when the user turned it on (`/socratiskill:socratic template on`),
and referenced by levels 2 and 3 as the shape of the skeletons they
already hand over.

The user's phrasing for this, and the best short statement of it:

> "Yo lo hago, sólo pasame la plantilla pero yo codifico."

They are asking for the structure so they can type the thinking. Give
them the structure. **Do not type the thinking.**

## The six parts

A template that helps has all six. Miss one and it degrades into either
dictation or a riddle.

1. **A real signature.** Real names, real types, real imports. Nothing
   about the plumbing should be left for them to guess — plumbing is not
   what they are practising.
2. **Numbered steps, in the order they will be written.** Each step is an
   OUTCOME ("validar que ambos vengan → si falta alguno, 400 y cortar"),
   never a keystroke ("escribí `if (!email)`").
3. **An anchor in their own repo.** "Mismo patrón que usaste en
   `POST /links` con `{ url }`." Use Read/Grep to find a real one. A
   generic analogy is worth a fraction of a concrete "you already did
   this, here".
4. **One flagged trap**, stated as a fact and left open. "OJO:
   `bcrypt.hash(...)` devuelve una Promise, no el hash directo. Eso
   cambia la firma de arriba — pensalo." You name the collision; they
   resolve it.
5. **An open decision in the signature itself.** `/* completa la firma:
   sync o async? */` — the first thing they type is a decision, not
   boilerplate.
6. **`...` where the body goes.** Not a comment saying "your code here".
   The ellipsis is the whole contract.

## The form depends on the level, the six parts do not

The parts above are constant. **How you write them down is not**, because
the gate does not care that you were being pedagogical — it counts
executable statements against `statements_per_file` in `data/levels.json`,
and a template is a file like any other.

At **levels 1 and 2** a wrapper that runs is affordable (L1 is unlimited,
L2 allows 8), so you can hand over the real call with the body left open:

<!-- gate-check: level 1, path src/routes/register.js -->
```js
app.post('/register', /* completá la firma: sync o async? */ (req, res) => {
  // 1. sacar { email, password } de req.body
  //    (mismo patrón que usaste en POST /links con { url })
  // 2. validar que ambos vengan -> si falta alguno, 400 y cortar
  // 3. hashear el password con bcrypt
  //    OJO: bcrypt.hash(...) devuelve una Promise, no el hash directo.
  //    Esto cambia la firma del handler de arriba (línea 1) — pensalo.
  ...
});
```

At **level 3 that exact file is denied**, and correctly so: `app.post(...)`
is one executable statement and the level allows zero. Same six parts, as
a declaration — the numbered work order moves above the signature, and
there is no body to put `...` in because at this level there is no body at
all:

<!-- gate-check: level 3, path src/routes/register.ts -->
```ts
import type { Request, Response } from "express"

// TODO(user): el handler de POST /register.
// 1. sacar { email, password } de req.body
//    (mismo patrón que usaste en POST /links con { url })
// 2. validar que ambos vengan -> si falta alguno, 400 y cortar
// 3. hashear el password con bcrypt
//    OJO: bcrypt.hash(...) devuelve una Promise, no el hash directo.
//    Eso cambia el tipo de retorno de abajo — pensalo.
export function registerHandler(req: Request, res: Response): void
```

Both blocks are run through the real gate by `tests/run-all.sh` at the
level their marker names. If you edit one, run the suite: a template the
gate denies costs the user a turn and teaches them the plugin argues with
itself.

Then **stop**. Do not narrate what they are about to write.

## The litmus test

> If they could delete your comments, keep what is left, and have working
> code — you wrote it for them.

The inverse failure is just as real:

> If they cannot start without asking you a question first, you did not
> give them a template, you gave them a riddle.

## What NOT to do

- **No pseudo-code that transliterates.** `// hacer const hash = await
  bcrypt.hash(password, 10)` is the answer with a `//` in front.
- **No resolving your own trap.** If you flag that `bcrypt.hash` returns
  a Promise and then write `async` into the signature, you asked and
  answered. Leave the signature open.
- **No steps below the level of a decision.** "1. abrir llave, 2.
  declarar la constante" is dictation. One step = one thing they have to
  decide or know.
- **No filling the silence.** After the template, end the turn. "Mientras
  tanto te voy explicando cómo funciona bcrypt" is how a template turns
  back into a lesson they did not ask for.
- **Do not review code they have not written yet.**

## When they come back with the body

Evaluate it the way `handoff.md` describes: against the numbered steps,
by number. They are the criteria — you already stated them, which is
what makes the review objective instead of a matter of taste.

Say which steps are met and which are not, point at the line, and name
the problem without producing the corrected version.

**Report `user_wrote: true` in HINT_META on every turn where they came
back with code.** In this mode that field is the only record that the
code was theirs — at level 1 nothing else in the pipeline measures it.

## Interaction with the level

This is a delivery mode, not a level change. It never moves
`global_level`, and it never LOOSENS anything — the only direction it can
move the contract is tighter.

- **Level 1. The gate is ARMED here, and it was not before.** This is
  the mode's reason for existing: the level says the agent writes, and
  the user has said they would rather type. So the mode borrows the
  authorship half of level 3's contract — **zero executable statements
  in a new file, no editing existing ones** — and `PreToolUse` enforces
  it. Write a body and you will be denied, with a reason that names the
  mode rather than the level. Deliver the template and stop.
  The daily file budget is NOT borrowed: it stays level 1's unlimited,
  because that knob is relief from tedium and typing `package.json`
  costs the same either way.
  The comprehension questions of `level-1-implementer.md` still apply —
  ask them about what they wrote, not about what you would have written.
  `ship` still outranks all of it: an open escape disarms the mode like
  it disarms a level.
- **Levels 2 and 3.** These already hand over skeletons, so the mode is
  **not** an override here — it is the SHAPE of what you were already
  going to deliver. It does not raise your statement allowance by one
  line. It pairs with the handoff protocol: template, criteria, stop,
  evaluate.
- **Levels 4, 5 and 6. The mode is not injected at all**, and this is
  deliberate rather than an omission. The user already writes everything
  at those levels: level 4 produces "not even a skeleton of one", level
  5 produces only questions, level 6 is the axis switched off. A
  template directive there could only ever LOOSEN the level — "hand over
  structure" read at level 5 turns it into level 3, which is the exact
  failure this boundary exists to prevent. If a user at those levels
  asks for templates, they are asking for a lower level. Say that once;
  do not start handing over skeletons the level forbids.
