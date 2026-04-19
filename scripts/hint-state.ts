/**
 * hint-state.ts — escalation logic for hint levels (0-5).
 *
 * Pure module port of opencode/src/socratic/hints.ts. The 6 DIRECTIVES
 * that describe each hint level live in rules/hint-ladder.md (model-facing
 * markdown); this file only owns the state transitions.
 *
 * Rules:
 *   - incorrect -> consecutiveFailures++. After ESCALATION_THRESHOLD (2),
 *                  ascend +1 and reset failures.
 *   - correct   -> consecutiveSuccesses++, descend using jump-down
 *                  (5 -> 3, 3+ -> 1, 1+ -> 0). Clears zeroKnowledgeActive.
 *   - zeroKnow  -> jump to 5, reset both counters, mark active.
 */

export namespace HintState {
  export type HintLevel = 0 | 1 | 2 | 3 | 4 | 5
  export type UserLevel = 1 | 2 | 3 | 4 | 5

  export interface State {
    currentLevel: HintLevel
    consecutiveFailures: number
    consecutiveSuccesses: number
    totalEscalations: number
    zeroKnowledgeActive: boolean
  }

  export const MIN_HINT = 0
  export const MAX_HINT = 5
  export const ESCALATION_THRESHOLD = 2

  export const HINT_NAMES: Record<HintLevel, string> = {
    0: "Pure socratic",
    1: "Orientation",
    2: "Analogy",
    3: "Reduction",
    4: "Explanation + verification",
    5: "Scaffolding",
  }

  export function getInitialHintLevel(userLevel: UserLevel): HintLevel {
    switch (userLevel) {
      case 1:
        return 5
      case 2:
        return 4
      case 3:
        return 0
      case 4:
        return 0
      case 5:
        return 0
    }
  }

  export function createInitialState(userLevel: UserLevel): State {
    return {
      currentLevel: getInitialHintLevel(userLevel),
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      totalEscalations: 0,
      zeroKnowledgeActive: false,
    }
  }

  export function processResponse(
    state: State,
    correct: boolean,
    zeroKnowledge: boolean,
  ): State {
    const next: State = { ...state }

    if (zeroKnowledge) {
      next.currentLevel = MAX_HINT as HintLevel
      next.consecutiveFailures = 0
      next.consecutiveSuccesses = 0
      next.zeroKnowledgeActive = true
      next.totalEscalations++
      return next
    }

    if (correct) {
      next.consecutiveSuccesses++
      next.consecutiveFailures = 0
      next.zeroKnowledgeActive = false
      next.currentLevel = descendLevel(state.currentLevel)
    } else {
      next.consecutiveFailures++
      next.consecutiveSuccesses = 0
      if (next.consecutiveFailures >= ESCALATION_THRESHOLD) {
        next.currentLevel = ascendLevel(state.currentLevel)
        next.consecutiveFailures = 0
        next.totalEscalations++
      }
    }

    return next
  }

  export function clampHint(level: number): HintLevel {
    return Math.max(MIN_HINT, Math.min(MAX_HINT, Math.round(level))) as HintLevel
  }

  export function clampUserLevel(level: number): UserLevel {
    return Math.max(1, Math.min(5, Math.round(level))) as UserLevel
  }

  export function hintName(level: HintLevel): string {
    return HINT_NAMES[level]
  }

  function ascendLevel(current: HintLevel): HintLevel {
    if (current >= MAX_HINT) return MAX_HINT as HintLevel
    return (current + 1) as HintLevel
  }

  function descendLevel(current: HintLevel): HintLevel {
    if (current >= 5) return 3 as HintLevel
    if (current >= 3) return 1 as HintLevel
    if (current >= 1) return 0 as HintLevel
    return 0 as HintLevel
  }
}
