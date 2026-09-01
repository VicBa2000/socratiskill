/**
 * shape-check.ts — Layer 1 of the RU-3 mitigation.
 *
 * THE PROBLEM. The create-vs-edit line is objective and the gate can
 * draw it without anyone's opinion. But nothing in that line stops the
 * agent from creating a file that does not exist and putting the entire
 * implementation inside it. In v0.4 that hole was bounded only because
 * the scaffold window lasted 20 minutes and the user had to open it. The
 * axis makes creation always-available, so the hole would be permanent.
 *
 * THE FRAMING THAT WORKS. Do not try to DETECT an implementation: that
 * is open-ended and semantic, and the model can always out-invent a
 * blacklist. Assert the opposite, closed property instead —
 *
 *     this content HAS THE SHAPE OF A SKELETON
 *
 * Every line is classified into exactly one category, and STATEMENT is
 * the RESIDUAL one. Unknown syntax, an unlisted language, a construct
 * nobody anticipated: all of it lands in STATEMENT and consumes budget.
 * The check FAILS CLOSED by construction rather than by enumeration,
 * which is why it does not need to be complete to be safe.
 *
 * POLARITY WARNING. This detector is deliberately RESTRICTIVE — when in
 * doubt, deny. That is the OPPOSITE tuning from detectDisguisedWrite()
 * in gate-tool.ts, which is deliberately PERMISSIVE. Not an
 * inconsistency: the cost of a false positive is asymmetric in opposite
 * directions. There it blocks the USER from running their own tests,
 * which is the thing the whole axis wants them doing. Here it only
 * blocks the AGENT, which retries with a thinner file and loses a turn.
 * Do not "harmonize" the two.
 */

export namespace ShapeCheck {
  export type Category =
    | "blank"
    | "comment"
    | "structural"
    | "import"
    | "declaration"
    | "marker"
    | "statement"

  export interface Config {
    codeExtensions: string[]
    markupExtensions: string[]
    markers: string[]
  }

  export const DEFAULT_CONFIG: Config = {
    codeExtensions: [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
      ".py", ".cs", ".java", ".go", ".rb", ".php",
      ".rs", ".c", ".h", ".cpp", ".hpp", ".kt", ".swift", ".vb",
      ".sql",
    ],
    markupExtensions: [
      ".html", ".htm", ".css", ".scss", ".sass", ".less",
      ".json", ".yaml", ".yml", ".xml", ".toml", ".ini", ".env",
      ".md", ".txt", ".csv", ".svg",
    ],
    markers: [
      "TODO", "FIXME", "NotImplementedException", "NotImplementedError",
      "not implemented", "unimplemented", "pass", "...",
    ],
  }

  export type FileClass = "code" | "markup"

  /**
   * Markup is judged by the line cap alone. An HTML or JSON skeleton is
   * legitimately all "content" — it has no bodies to leave empty, so a
   * statement budget would deny every honest scaffold.
   *
   * Anything unrecognized is treated as CODE, which is the strict side.
   */
  export function classifyFile(path: string, cfg: Config = DEFAULT_CONFIG): FileClass {
    const lower = path.toLowerCase()
    for (const ext of cfg.markupExtensions) {
      if (lower.endsWith(ext)) return "markup"
    }
    return "code"
  }

  /** Strip a trailing line comment so marker and structure tests see code only. */
  function stripLineComment(line: string): string {
    // Not string-literal aware on purpose: a `//` inside a string would
    // truncate the line early, which can only ever make the remainder
    // look MORE like a skeleton... except that it could hide a statement.
    // So we only strip when the marker is not inside quotes on that line.
    const idx = firstUnquoted(line, ["//", "#", "--"])
    return idx < 0 ? line : line.slice(0, idx)
  }

  function firstUnquoted(line: string, tokens: string[]): number {
    let quote: string | null = null
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (quote) {
        if (c === "\\") { i++; continue }
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue }
      for (const t of tokens) {
        if (line.startsWith(t, i)) return i
      }
    }
    return -1
  }

  const IMPORT_RE =
    /^(import|from|export\s+\*|export\s+\{|using|#include|#import|package|require|use|extern\s+crate)\b/
  const REQUIRE_ASSIGN_RE = /^(const|let|var)\s+[\w{},\s*]+=\s*require\s*\(/

  const DECL_KEYWORD_RE =
    /^(export\s+)?(default\s+)?(public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|sealed\s+|virtual\s+|override\s+|final\s+|partial\s+|async\s+|declare\s+)*(function|class|interface|type|enum|struct|namespace|module|trait|impl|record|def|fn|func|sub|proc)\b/

  /** A method signature: modifiers, a name, a parameter list. */
  const METHOD_SIG_RE =
    /^(export\s+)?(public|private|protected|internal|static|abstract|virtual|override|final|async|declare)\s+[\w<>\[\],\s.?]+\([^)]*\)\s*(:\s*[\w<>\[\],\s.|?]+)?\s*[{;]?\s*$/

  /**
   * An interface member with no modifiers at all — `Task<T> Login(string
   * e);` in C#, `login(e: string): void;` in a TS interface. It ends in a
   * semicolon and has no body, which is what separates it from a call.
   */
  const INTERFACE_MEMBER_RE =
    /^[\w<>\[\],\s.?]+\s+\w+\s*\([^)]*\)\s*;\s*$|^\w+\??\s*\([^)]*\)\s*:\s*[\w<>\[\],\s.|?]+\s*;\s*$/

  /** `export function foo(a: T): R` with no body on the line. */
  const BARE_SIG_RE =
    /^(export\s+)?(async\s+)?function\s+\w+\s*(<[^>]*>)?\s*\([^)]*\)\s*(:\s*[^{;]+)?\s*[;]?\s*$/

  /** An arrow function that opens a body but puts nothing in it. */
  const ARROW_OPEN_RE =
    /^(export\s+)?(const|let|var)\s+\w+\s*(:[^=]+)?=\s*(async\s*)?\([^)]*\)\s*(:\s*[^=]+)?=>\s*\{?\s*$/

  /**
   * `name: Type` / `name?: Type` with no call and no assignment — an
   * interface field, a type member, or a parameter on its own line.
   *
   * Requiring the absence of `(` and `=` is what keeps an object literal
   * entry with a computed value (`foo: compute(),`) out of this bucket.
   */
  const FIELD_RE =
    /^(public\s+|private\s+|protected\s+|internal\s+|readonly\s+|static\s+|final\s+|const\s+|val\s+|var\s+)*\w+\??\s*:\s*[^=(]+[,;]?\s*$/

  const STRUCTURAL_RE = /^[{}()\[\];,<>]+$/

  /** A declaration line that also carries a body on the same line. */
  function hasInlineBody(code: string): boolean {
    const open = code.indexOf("{")
    if (open < 0) return false
    const rest = code.slice(open + 1).trim()
    return rest.length > 0 && rest !== "}" && !/^\}+[;,]?$/.test(rest)
  }

  export interface LineResult {
    category: Category
    line: string
  }

  /**
   * Classify every line. Block comments are tracked across lines so a
   * commented-out implementation does not count as statements — it also
   * does not help the user, but it is honestly a comment.
   */
  export function classify(content: string, cfg: Config = DEFAULT_CONFIG): LineResult[] {
    const out: LineResult[] = []
    let inBlockComment = false

    for (const rawLine of content.split("\n")) {
      const line = rawLine
      const trimmed = line.trim()

      if (inBlockComment) {
        if (trimmed.includes("*/") || trimmed.includes("-->")) inBlockComment = false
        out.push({ category: "comment", line })
        continue
      }

      if (trimmed === "") { out.push({ category: "blank", line }); continue }

      // Opens a block comment and does not close it on the same line.
      if ((trimmed.startsWith("/*") && !trimmed.includes("*/")) ||
          (trimmed.startsWith("<!--") && !trimmed.includes("-->"))) {
        inBlockComment = true
        out.push({ category: "comment", line })
        continue
      }

      // Preprocessor includes look like comments (`#`) but are imports.
      if (/^#\s*(include|import)\b/.test(trimmed)) {
        out.push({ category: "import", line })
        continue
      }

      if (trimmed.startsWith("//") || trimmed.startsWith("*") ||
          trimmed.startsWith("/*") || trimmed.startsWith("<!--") ||
          trimmed.startsWith("#") || trimmed.startsWith("--")) {
        out.push({ category: "comment", line })
        continue
      }

      const code = stripLineComment(line).trim()
      if (code === "") { out.push({ category: "comment", line }); continue }

      if (STRUCTURAL_RE.test(code)) { out.push({ category: "structural", line }); continue }

      if (IMPORT_RE.test(code) || REQUIRE_ASSIGN_RE.test(code)) {
        out.push({ category: "import", line })
        continue
      }

      if (isMarker(code, cfg)) { out.push({ category: "marker", line }); continue }

      // A declaration only counts as one if it does NOT carry a body.
      // `function f() { return 1 }` is an implementation wearing a
      // signature's clothes.
      const looksDeclarative =
        DECL_KEYWORD_RE.test(code) || METHOD_SIG_RE.test(code) ||
        BARE_SIG_RE.test(code) || ARROW_OPEN_RE.test(code) ||
        FIELD_RE.test(code) || INTERFACE_MEMBER_RE.test(code)

      if (looksDeclarative && !hasInlineBody(code)) {
        out.push({ category: "declaration", line })
        continue
      }

      out.push({ category: "statement", line })
    }

    return out
  }

  /**
   * A body stand-in. Checked against the CODE part of the line only, so
   * a trailing `// TODO` on a real statement cannot launder it — that
   * line was already stripped to its code before we get here.
   */
  function isMarker(code: string, cfg: Config): boolean {
    const bare = code.replace(/[;,]+$/, "").trim()
    if (bare === "pass" || bare === "..." || bare === "…") return true
    if (/^(throw|raise)\b/i.test(bare)) {
      const lower = bare.toLowerCase()
      for (const m of cfg.markers) {
        if (lower.includes(m.toLowerCase())) return true
      }
    }
    return false
  }

  /**
   * How many statements one statement-line is worth.
   *
   * Counting one-per-line is the obvious rule and it has a hole: a whole
   * implementation can be packed onto a handful of semicolon-separated
   * lines and slip under the budget, while the 80-line cap notices
   * nothing. So a statement line counts once per top-level `;`-separated
   * segment. Semicolons inside strings do not split (firstUnquoted's
   * quote tracking), and a trailing `;` does not add a phantom segment.
   */
  export function statementWeight(code: string): number {
    let segments = 1
    let quote: string | null = null
    let sawContent = false
    for (let i = 0; i < code.length; i++) {
      const c = code[i]!
      if (quote) {
        if (c === "\\") { i++; continue }
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; sawContent = true; continue }
      if (c === ";") {
        // Only counts as a separator when something follows it.
        if (sawContent && code.slice(i + 1).trim() !== "") segments++
        sawContent = false
        continue
      }
      if (!/\s/.test(c)) sawContent = true
    }
    return segments
  }

  export function countStatements(content: string, cfg: Config = DEFAULT_CONFIG): number {
    let total = 0
    for (const r of classify(content, cfg)) {
      if (r.category !== "statement") continue
      total += statementWeight(stripLineComment(r.line).trim())
    }
    return total
  }

  /** The first few offending lines, for a denial the model can act on. */
  export function statementSamples(
    content: string,
    limit = 3,
    cfg: Config = DEFAULT_CONFIG,
  ): string[] {
    const out: string[] = []
    for (const r of classify(content, cfg)) {
      if (r.category !== "statement") continue
      const t = r.line.trim()
      out.push(t.length > 60 ? t.slice(0, 57) + "..." : t)
      if (out.length >= limit) break
    }
    return out
  }
}
