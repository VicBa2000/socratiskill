/**
 * Taxonomy of knowledge domains.
 *
 * Ported from ../opencode/packages/opencode/src/socratic/taxonomy.ts with
 * minimal changes: data path adjusted to ../data/domains.json and a CLI
 * entry point added so the script is directly executable via
 * `bun run scripts/taxonomy.ts [--all]` reading the user message from
 * stdin. Domain keys stay in Spanish for parity with error-map entries.
 */

import domainsData from "../data/domains.json"

export namespace Taxonomy {
  interface RawDomainData {
    label: string
    keywords: string[]
  }

  const DOMAIN_ENTRIES = Object.entries(domainsData).filter(
    ([k]) => !k.startsWith("_"),
  ) as Array<[string, RawDomainData]>

  type LoadedDomains = {
    [key: string]: { readonly label: string; readonly keywords: readonly string[] }
  }

  export const DOMAINS: LoadedDomains = Object.fromEntries(
    DOMAIN_ENTRIES.map(([key, val]) => [
      key,
      { label: val.label, keywords: val.keywords },
    ]),
  ) as LoadedDomains

  export type DomainKey = keyof typeof DOMAINS & string

  export const ALL_DOMAINS = Object.keys(DOMAINS) as DomainKey[]

  export function detectDomains(message: string): DomainKey[] {
    const lower = message.toLowerCase()
    const scores: { domain: DomainKey; score: number }[] = []

    for (const [domain, { keywords }] of Object.entries(DOMAINS)) {
      let score = 0
      for (const kw of keywords) {
        if (kw.length <= 3) {
          const regex = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i")
          if (regex.test(lower)) score++
        } else {
          if (lower.includes(kw)) score++
        }
      }
      if (score > 0) {
        scores.push({ domain: domain as DomainKey, score })
      }
    }

    return scores
      .sort((a, b) => b.score - a.score)
      .map((s) => s.domain)
  }

  export function detectPrimaryDomain(message: string): DomainKey | null {
    const domains = detectDomains(message)
    return domains[0] ?? null
  }

  function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
}

// ── CLI ────────────────────────────────────────────────────
//
// Usage:  bun run scripts/taxonomy.ts [--all] < msg
// Output: by default one-line JSON with { primary, label } for the best
// matching domain (or null). With --all, returns all matching domains
// ranked.

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  const all = args.includes("--all")

  const message = await Bun.stdin.text()

  if (all) {
    const ranked = Taxonomy.detectDomains(message).map((key) => ({
      key,
      label: Taxonomy.DOMAINS[key]!.label,
    }))
    console.log(JSON.stringify({ domains: ranked }))
  } else {
    const primary = Taxonomy.detectPrimaryDomain(message)
    const out = primary
      ? { primary, label: Taxonomy.DOMAINS[primary]!.label }
      : { primary: null, label: null }
    console.log(JSON.stringify(out))
  }
}
