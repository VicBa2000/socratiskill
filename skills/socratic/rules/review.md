# Review mode (Leitner spaced repetition)

Activated when the user runs `/socratiskill:socratic review` and
`pick-review.ts` returns a card. If it returns "no review cards due",
this protocol does not apply.

## Two-turn flow

**Turn 1 (kickoff — the skill just ran pick-review):**

1. Read the stdout of `pick-review.ts` and extract `topic`, `domain`,
   `fails`, `overdue_by`, `last_hint_level`.
2. Compose a single, concrete, **verifiable** question (closed answer,
   not open-ended) about the topic, appropriate to the user's `level`
   in SOCRATIC CONTEXT. Good question examples:
   - "What does this snippet print?" + 3 lines of code.
   - "Which of these statements is true about <X>? A) ... B) ..."
   - "Fix this code: <5 lines with 1 bug>."
   Bad questions: "Explain X to me" (open, no clean true/false).
3. Close the turn with HINT_META as an HTML comment (invisible to the
   user):
   ```
   <!-- HINT_META {"topic":"<card.topic>","correct":null,"domain":"<card.domain>","hintLevel":<0-5>} /HINT_META -->
   ```
   - `topic`: **exactly** the card's slug (do not rename).
   - `correct: null` (no answer yet).

**Turn 2 (evaluation — the user responded):**

1. Judge the response against your mental model of "correct":
   - Correct: acknowledge (1 sentence) + why (1 sentence).
   - Incorrect: show the error, give the correct answer, and a brief
     counter-example.
2. Close with HINT_META:
   ```
   <!-- HINT_META {"topic":"<card.topic>","correct":<true|false>,"domain":"<card.domain>","hintLevel":<0-5>} /HINT_META -->
   ```

The `Stop` hook (record-turn.ts) reads `correct` and updates
error-map.json:
- `true` with 2 consecutive correct -> advance leitner_box
  (1->3->7->14->30 days).
- Last box + 2nd correct -> mark `resolved: true`.
- `false` -> box resets to 0, next_review_at = +1d.

## Critical rule: topic slug consistency

The topic in HINT_META MUST be identical to the slug returned by
`pick-review.ts`. Variations ("react-hook" vs "react-hooks", "closure"
vs "closures") create new entries in error-map and leave the original
card stuck. Copy-paste the slug — do not rewrite it.

## "No review cards due" case

If pick-review's stdout starts with "no review cards due":

```
no review cards due. all review topics are either future-scheduled
or marked resolved.
```

Do not generate a question. HINT_META with `topic: null, correct: null`.
