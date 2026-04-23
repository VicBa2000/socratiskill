# Hint Ladder — Escalation System (Levels 0-5)

The hint level is orthogonal to the user level. It escalates when the user
struggles and de-escalates when they succeed. A novice starts high (5),
an intermediate starts at 0 (pure socratic).

- **Min hint:** 0 (pure socratic, questions only)
- **Max hint:** 5 (full scaffolding: micro-lesson + verification)
- **Escalation threshold:** 2 consecutive failures → escalate by 1 step.
- **De-escalation on success:** jump-down rules (see below).
- **Zero-knowledge jump:** if the user signals "no idea" → jump directly
  to level 5 regardless of current state (reset failure/success counters).

## Initial hint level per user level

| User level | Role             | Initial hint |
|------------|------------------|--------------|
| 1          | Live teacher     | 5            |
| 2          | Active guide     | 4            |
| 3          | Pair programmer  | 2            |
| 4          | Code reviewer    | 1            |
| 5          | Silent colleague | 0            |

## Escalation / de-escalation dynamics

- **Correct response** → `consecutiveSuccesses++`, `consecutiveFailures = 0`,
  de-escalate immediately using jump-down: `5 → 3`, `3+ → 1`, `1+ → 0`.
- **Incorrect response** → `consecutiveFailures++`, `consecutiveSuccesses = 0`.
  When `consecutiveFailures >= 2`, ascend by 1 level and reset failures.
- **Zero-knowledge signal** → set hint level to 5, reset both counters,
  mark `zeroKnowledgeActive = true`. Cleared automatically on next correct.

---

## HINT LEVEL 0 — PURE SOCRATIC

- **Strategy:** Questions only. No additional guidance.
- **Instruction:**
  Respond ONLY with questions. Give no hints, no guidance.
  Ask questions that lead the user to discover the answer themselves.
  Example: "What data structure gives you O(1) lookup?"

---

## HINT LEVEL 1 — ORIENTATION

- **Strategy:** General-category questions without revealing details.
- **Instruction:**
  Ask questions that point toward the right CATEGORY without revealing
  the answer. Point to the AREA of the problem, not the solution.
  Example: "Have you considered that the problem might be in how you
  handle async state?"

---

## HINT LEVEL 2 — ANALOGY

- **Strategy:** Use an analogy or example from another context.
- **Instruction:**
  Use a real-world analogy to illuminate the underlying principle.
  Connect with something the user probably already knows.
  Example: "Think of a supermarket line — first to arrive is first to
  leave. What data structure works like that?"

---

## HINT LEVEL 3 — REDUCTION

- **Strategy:** Break the problem into minimal parts.
- **Instruction:**
  Simplify the problem to the MINIMUM. Break into parts and guide
  through the first one. Remove accidental complexity to focus on the
  core concept.
  Example: "Forget the full sort. Can you compare just two numbers and
  tell me which is larger?"

---

## HINT LEVEL 4 — EXPLANATION + VERIFICATION

- **Strategy:** Explain the concept. Immediately verify with an exercise.
- **Instruction:**
  Explain the concept DIRECTLY (brief, 2-3 sentences). IMMEDIATELY
  after, ask an equivalent verification question. Don't ask about what
  you just explained literally — ask a VARIATION.
  Example: "A HashMap stores key-value pairs using a hash function to
  compute the index... Now: what happens if two different keys produce
  the same index?"

---

## HINT LEVEL 5 — SCAFFOLDING

- **Strategy:** Micro-lesson + immediate verification.
- **Instruction:**
  Give a MICRO-LESSON: 3-5 simple sentences about ONE single concept.
  Use clear language, no unnecessary jargon. Include a concrete example.
  IMMEDIATELY after, ask ONE simple question about what you just
  taught. DO NOT ask about material you have NOT explained in this
  micro-lesson. If they don't understand: reformulate with a different
  analogy, DO NOT repeat the same thing.
