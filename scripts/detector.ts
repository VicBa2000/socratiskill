/**
 * Detector for zero-knowledge signals and copy-paste behavior.
 *
 * Ported from ../opencode/packages/opencode/src/socratic/detector.ts with
 * minimal changes: data path adjusted to ../data/technical-terms.json and
 * a CLI entry point added at the bottom so the script is directly
 * executable via `bun run scripts/detector.ts [--user-level N]
 * [--prev-len N]` reading the user message from stdin.
 */

import technicalTermsJson from "../data/technical-terms.json"

export namespace Detector {
  const ZERO_KNOWLEDGE_PATTERNS = [
    /\bno\s+s[eé]\b/i,
    /\bni\s+idea\b/i,
    /\bno\s+entiendo\b/i,
    /\bno\s+conozco\b/i,
    /\bno\s+tengo\s+idea\b/i,
    /\bqu[eé]\s+es\s+eso\b/i,
    /\bnunca\s+(he\s+)?(usado|visto|trabajado|escuchado)\b/i,
    /\bno\s+he\s+(usado|visto|trabajado|escuchado)\b/i,
    /\bno\s+me\s+suena\b/i,
    /\bestoy\s+perdid[oa]\b/i,
    /\bdesde\s+cero\b/i,
    /\bempezar\s+desde\b/i,
    /\bno\s+tengo\s+experiencia\b/i,
    /\bsoy\s+nuev[oa]\b/i,
    /\bprimera\s+vez\b/i,
    /\bi\s+don'?t\s+know\b/i,
    /\bno\s+idea\b/i,
    /\bi\s+don'?t\s+understand\b/i,
    /\bnever\s+(used|seen|worked|heard)\b/i,
    /\bi'?m\s+lost\b/i,
    /\bfrom\s+scratch\b/i,
    /\bno\s+experience\b/i,
    /\bi'?m\s+new\s+to\b/i,
    /\bfirst\s+time\b/i,
    /\bwhat\s+is\s+that\b/i,
    /\bwhat'?s\s+that\b/i,
  ]

  export function detectZeroKnowledge(message: string): number {
    let count = 0
    for (const pattern of ZERO_KNOWLEDGE_PATTERNS) {
      if (pattern.test(message)) count++
    }
    return count
  }

  export function hasZeroKnowledge(message: string): boolean {
    return detectZeroKnowledge(message) > 0
  }

  const SLOW_DOWN_PATTERNS = [
    /\bm[aá]s\s+lento\b/i,
    /\bm[aá]s\s+despacio\b/i,
    /\bno\s+tan\s+r[aá]pido\b/i,
    /\bpara\b.*\bexplica\b/i,
    /\bvamos\s+m[aá]s\s+lento\b/i,
    /\bpaso\s+a\s+paso\b/i,
    /\bexplica\s+mejor\b/i,
    /\bno\s+entend[ií]\b/i,
    /\brepite\b/i,
    /\bme\s+perd[ií]\b/i,
    /\bslow\s+down\b/i,
    /\bnot\s+so\s+fast\b/i,
    /\bstep\s+by\s+step\b/i,
    /\bexplain\s+(again|better|more)\b/i,
    /\bwait\b.*\bexplain\b/i,
    /\bi'?m\s+confused\b/i,
    /\bcan\s+you\s+repeat\b/i,
  ]

  export function detectSlowDownRequest(message: string): boolean {
    return SLOW_DOWN_PATTERNS.some((p) => p.test(message))
  }

  export interface CopyPasteResult {
    isCopy: boolean
    confidence: number
    reasons: string[]
  }

  export function detectCopyPaste(
    message: string,
    userLevel: number,
    previousMessageLength: number,
  ): CopyPasteResult {
    const reasons: string[] = []
    let score = 0

    const codeBlocks = message.match(/```[\s\S]*?```/g) ?? []
    const totalCodeLines = codeBlocks.reduce((sum, block) => {
      return sum + block.split("\n").length
    }, 0)

    if (totalCodeLines > 15 && userLevel <= 2) {
      score += 0.4
      reasons.push("long code block for novice level")
    }

    if (codeBlocks.length >= 3) {
      score += 0.2
      reasons.push("multiple code blocks in one message")
    }

    if (previousMessageLength > 0 && message.length > previousMessageLength * 5) {
      score += 0.2
      reasons.push("large jump in message length")
    }

    if (userLevel <= 2) {
      const sophisticatedPatterns = [
        /\bawait\b.*\bPromise\.all\b/,
        /\bgeneric\b.*<.*>/,
        /\binterface\b.*\{[\s\S]*\}/,
        /\bclass\b.*\bextends\b.*\bimplements\b/,
        /\btry\b.*\bcatch\b.*\bfinally\b/,
        /\breduce\b.*=>\s*\{/,
      ]
      const sophisticatedCount = sophisticatedPatterns.filter((p) => p.test(message)).length
      if (sophisticatedCount >= 2) {
        score += 0.3
        reasons.push("advanced patterns for declared level")
      }
    }

    return {
      isCopy: score >= 0.4,
      confidence: Math.min(1.0, score),
      reasons,
    }
  }

  const TECHNICAL_TERMS: readonly string[] = technicalTermsJson.terms

  export function countTechnicalTerms(message: string): number {
    const lower = message.toLowerCase()
    let count = 0
    for (const term of TECHNICAL_TERMS) {
      if (lower.includes(term)) count++
    }
    return count
  }

  export function hasTechnicalVocabulary(message: string): boolean {
    return countTechnicalTerms(message) >= 2
  }
}

// ── CLI ────────────────────────────────────────────────────
//
// Usage:  bun run scripts/detector.ts [--user-level N] [--prev-len N] < msg
// Output: one-line JSON with all detector signals for the input message.

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  let userLevel = 3
  let prevLen = 0
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--user-level") userLevel = Number(args[++i]) || 3
    else if (args[i] === "--prev-len") prevLen = Number(args[++i]) || 0
  }

  const message = await Bun.stdin.text()

  const result = {
    zeroKnowledge: Detector.detectZeroKnowledge(message),
    hasZeroKnowledge: Detector.hasZeroKnowledge(message),
    slowDown: Detector.detectSlowDownRequest(message),
    technicalTerms: Detector.countTechnicalTerms(message),
    hasTechnicalVocabulary: Detector.hasTechnicalVocabulary(message),
    copyPaste: Detector.detectCopyPaste(message, userLevel, prevLen),
  }

  console.log(JSON.stringify(result))
}
