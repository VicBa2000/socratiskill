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
 *
 * ---------------------------------------------------------------------
 * WHY THE RECOGNIZER GREW A VOCABULARY (post-v0.5.1)
 *
 * Failing closed is safe, but it is only USABLE if the recognizer
 * actually speaks the language in front of it. Measuring that (see
 * tests/fixtures/shape-languages.ts) showed the original regexes spoke
 * four languages — TS/JS, Python, C# and Java — while code_extensions
 * listed twenty. Nine of thirteen honest skeletons were denied. Because
 * the allowance is 0 at levels 3-5, ONE false positive kills the whole
 * file, so eleven of the twenty extensions were effectively unusable:
 * the agent could not scaffold anything and every attempt burned a turn.
 *
 * The fix is vocabulary, NOT a softer polarity. Every pattern added
 * below has to be a construct that provably carries no body. The
 * guardrails in tests/fixtures/shape-why.ts (return, :=, INSERT, UPDATE,
 * SELECT, assignment, call) must keep counting as statements; they are
 * what proves the widening did not become a hole.
 *
 * TWO RULES KEEP THE WIDENING HONEST:
 *
 *   1. LANGUAGE-SPECIFIC RULES ARE GATED BY EXTENSION. A rule that has
 *      to be loose to be useful (SQL column definitions, Go's
 *      colon-less struct fields) applies ONLY to that language, so it
 *      cannot loosen TypeScript. `generic` is the strict fallback, and
 *      an unrecognized extension gets it.
 *   2. EVERY LOOSE RULE IS GUARDED BY A STATEMENT-KEYWORD DENYLIST.
 *      `Email string` and `return nil` have the same two-token shape;
 *      what separates them is that one starts with a keyword that
 *      introduces execution. The denylist is checked FIRST and wins.
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
   * Which language-specific rules may fire. `generic` is the strict
   * fallback and is what an unrecognized extension gets, so adding a
   * language here can only ever RELAX, never tighten — which is why a
   * new entry needs a guardrail case in shape-why.ts alongside it.
   */
  export type Lang = "generic" | "sql" | "go" | "c" | "rust" | "kotlin" | "swift" | "php" | "ruby"

  const LANG_BY_EXT: Array<[string, Lang]> = [
    [".sql", "sql"],
    [".go", "go"],
    [".c", "c"], [".h", "c"], [".cpp", "c"], [".hpp", "c"],
    [".rs", "rust"],
    [".kt", "kotlin"],
    [".swift", "swift"],
    [".php", "php"],
    [".rb", "ruby"],
  ]

  export function languageOf(path: string): Lang {
    const lower = path.toLowerCase()
    for (const [ext, lang] of LANG_BY_EXT) {
      if (lower.endsWith(ext)) return lang
    }
    return "generic"
  }

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

  /**
   * THE GUARD. Anything that introduces execution. Checked before every
   * loose rule below, because the loose rules recognize SHAPES and a
   * statement can wear a declaration's shape: `Email string` and
   * `return nil` are both "two bare tokens". The keyword is the only
   * thing that tells them apart, so this list is what keeps the widened
   * recognizer from becoming a hole. Add to it freely; it can only ever
   * make the check stricter.
   */
  const STATEMENT_KEYWORD_RE =
    /^(?:return|if|elif|else|for|foreach|while|switch|case|when|break|continue|goto|throw|raise|yield|await|defer|go|del|delete|new|print|println|echo|assert|with|try|catch|finally|do|repeat|guard|panic|exit|emit|puts|require|include|typeof|instanceof|this|self|super)\b/i

  /**
   * Modifiers that may precede a declaration keyword. Purely additive:
   * each one only qualifies a declaration that has to be there anyway,
   * so widening this cannot admit a body on its own.
   */
  const MOD =
    "(?:export|default|public|private|protected|internal|static|abstract|sealed|virtual|override|final|partial|async|declare|pub(?:\\([\\w:]+\\))?|open|data|inline|operator|suspend|fileprivate|unsafe|extern|const|readonly|lateinit|companion|value|friend|mutable|reified|tailrec|infix)\\s+"

  const IMPORT_RE =
    /^(import|from|export\s+\*|export\s+\{|using|#include|#import|package|require|use|extern\s+crate)\b/
  const REQUIRE_ASSIGN_RE = /^(const|let|var)\s+[\w{},\s*]+=\s*require\s*\(/

  /** CAUSE 1 + 2: unknown modifiers and unknown declaration keywords. */
  const DECL_KEYWORD_RE = new RegExp(
    "^(?:" + MOD + ")*" +
      "(?:function|class|interface|type|enum|struct|namespace|module|trait|impl|record|def|fn|fun|func|sub|proc|protocol|typedef|extension|object|actor|union|delegate|event|contract|annotation|mod)\\b",
  )

  /** A method signature: modifiers, a name, a parameter list. */
  const METHOD_SIG_RE = new RegExp(
    "^(?:" + MOD + ")+[\\w<>\\[\\],\\s.?*]+\\([^)]*\\)\\s*(?::\\s*[\\w<>\\[\\],\\s.|?]+)?\\s*[{;]?\\s*$",
  )

  /**
   * An interface member with no modifiers at all — `Task<T> Login(string
   * e);` in C#, `login(e: string): void;` in a TS interface. It ends in a
   * semicolon and has no body, which is what separates it from a call.
   */
  const INTERFACE_MEMBER_RE =
    /^[\w<>\[\],\s.?]+\s+\w+\s*\([^)]*\)\s*;\s*$|^\w+\??\s*\([^)]*\)\s*:\s*[\w<>\[\],\s.|?]+\s*;\s*$/

  /**
   * CAUSE 5: a signature whose return type carries a pointer or a
   * qualifier — `ringbuf_t *ringbuf_new(size_t n);`, `Task<T> Run(A a)`.
   *
   * The `\s+` between the type and the name is load-bearing: without it
   * `foo(1);` matches by splitting "foo" into a type and a name. Dots are
   * excluded from the type so `db.insert(order);` cannot match, and the
   * STATEMENT_KEYWORD guard removes `return foo(x);` and `new Foo(x);`.
   */
  const TYPED_SIG_RE =
    /^[A-Za-z_][\w\s<>,\[\]]*?\s+\**\w+\s*\([^()]*\)\s*(?:const\s*)?[;{]?\s*$/

  /**
   * CAUSE 4: `name: Type` with a visibility prefix the old regex did not
   * know (`pub entries: HashMap<..>`).
   *
   * Requiring the absence of `(` and `=` is what keeps an object literal
   * entry with a computed value (`foo: compute(),`) out of this bucket.
   */
  const FIELD_RE =
    /^(?:public\s+|private\s+|protected\s+|internal\s+|readonly\s+|static\s+|final\s+|const\s+|val\s+|var\s+|let\s+|open\s+|lateinit\s+|override\s+|abstract\s+|pub(?:\([\w:]+\))?\s+)*\w+\??\s*:\s*[^=(]+[,;]?\s*$/

  /** `export function foo(a: T): R` with no body on the line. */
  const BARE_SIG_RE =
    /^(export\s+)?(async\s+)?function\s+\w+\s*(<[^>]*>)?\s*\([^)]*\)\s*(:\s*[^{;]+)?\s*[;]?\s*$/

  /** An arrow function that opens a body but puts nothing in it. */
  const ARROW_OPEN_RE =
    /^(export\s+)?(const|let|var)\s+\w+\s*(:[^=]+)?=\s*(async\s*)?\([^)]*\)\s*(:\s*[^=]+)?=>\s*\{?\s*$/

  /**
   * CAUSE 3: a field declared `Name Type`, with no colon — Go and C
   * struct members. Gated to those two languages, because in Ruby the
   * very same shape is a method call (`puts total`).
   *
   * No `(`, `=`, `{` or `.` may appear, and the STATEMENT_KEYWORD guard
   * runs first, which is what keeps `return nil` and `total := 0` out.
   */
  const BARE_FIELD_RE =
    /^(?:var\s+|val\s+|let\s+|const\s+|readonly\s+|pub(?:\([\w:]+\))?\s+|public\s+|private\s+)?[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s+\**[\w.\[\]<>*]+(?:\s*`[^`]*`)?\s*,?\s*$/

  /**
   * CAUSE 5 (Go form): an interface member — `ByID(ctx C, id int64)
   * (*User, error)`.
   *
   * The return spec is REQUIRED, not optional. Without that requirement
   * a bare call `doWork()` would match, which is a real statement in Go.
   * The cost is that a no-return member like `Close()` still counts; that
   * is the fail-closed side and it is the right side to err on.
   */
  const GO_IFACE_RE =
    /^\w+\s*\([^()]*\)\s*(?:\([^()]*\)|[\w*\[\].]+)\s*$/

  /** CAUSE 6: block terminators that are words rather than punctuation. */
  const TERMINATOR_RE =
    /^(?:end|begin|loop|else|do)\b[\s\w]*$|^end[;,]?$/i

  /** CAUSE 6: language preamble that carries no logic. */
  const PREAMBLE_RE = /^(?:<\?php|<\?=|\?>|#!.*|<\?xml\b.*|%>|<%@.*)$/

  /** CAUSE 6 (Go form): a bare string inside an `import ( ... )` block. */
  const GO_IMPORT_MEMBER_RE = /^(?:[\w.]+\s+)?"[^"]*"$/

  /**
   * CAUSE 8: SQL. DDL is structure by any reading, so CREATE/ALTER/DROP
   * of a schema object is a declaration. DROP is included deliberately:
   * a down-migration is legitimately all DROPs, and the gate's job is to
   * stop the agent from doing the USER'S THINKING, not to police
   * destructive SQL — that is a different concern with a different owner.
   */
  const SQL_DDL_RE =
    /^(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?(?:TABLE|INDEX|VIEW|TYPE|SCHEMA|PROCEDURE|PROC|FUNCTION|TRIGGER|SEQUENCE|DATABASE|CONSTRAINT)\b/i

  /** Anything that reads or writes data. Guard for the SQL rules below. */
  const SQL_STATEMENT_RE =
    /^(?:SELECT|INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE|CALL|PRINT|RAISERROR|THROW|FETCH|OPEN|CLOSE|WHILE|IF|RETURN|COMMIT|ROLLBACK|TRUNCATE|GRANT|REVOKE|USE|WITH|VALUES|FROM|WHERE|JOIN|ORDER|GROUP|HAVING|UNION|INTO)\b/i

  /**
   * A column definition or a procedure parameter: `id BIGINT PRIMARY
   * KEY,`, `@CustomerId BIGINT,`. Guarded by SQL_STATEMENT_RE, which is
   * what keeps `SELECT ... FROM ...` and `EXEC sp_foo` out.
   */
  const SQL_COLUMN_RE =
    /^[@\[]?\w+\]?\s+[A-Za-z]\w*(?:\s*\([^)]*\))?[\w\s()',.-]*,?\s*$/

  /** Session pragmas: boilerplate at the top of a proc, never logic. */
  const SQL_PRAGMA_RE =
    /^SET\s+(?:NOCOUNT|ANSI_NULLS|QUOTED_IDENTIFIER|XACT_ABORT|ANSI_PADDING|ANSI_WARNINGS|CONCAT_NULL_YIELDS_NULL|NUMERIC_ROUNDABORT|ARITHABORT|TRANSACTION\s+ISOLATION)\b/i

  /** SQL batch/section separators. */
  const SQL_SEPARATOR_RE = /^(?:GO|AS|BEGIN|END)\s*;?$/i

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
  export function classify(
    content: string,
    cfg: Config = DEFAULT_CONFIG,
    lang: Lang = "generic",
  ): LineResult[] {
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

      // CAUSE 6: `<?php`, a shebang, an XML declaration. Checked before
      // the comment tests because `#!` would otherwise read as a comment
      // and before everything else because it carries no code at all.
      if (PREAMBLE_RE.test(trimmed)) {
        out.push({ category: "structural", line })
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

      // CAUSE 6: `end`, `begin` and friends. Safe generically — alone on
      // a line these carry no logic in any language that has them.
      if (TERMINATOR_RE.test(code)) { out.push({ category: "structural", line }); continue }

      // ---- language-gated rules -------------------------------------
      // Each of these is loose enough to be useful only inside its own
      // language, so it must never be allowed to judge another one.
      const langResult = classifyForLang(code, lang)
      if (langResult) { out.push({ category: langResult, line }); continue }

      // A declaration only counts as one if it does NOT carry a body.
      // `function f() { return 1 }` is an implementation wearing a
      // signature's clothes.
      const startsWithKeyword = STATEMENT_KEYWORD_RE.test(code)
      const looksDeclarative =
        DECL_KEYWORD_RE.test(code) || METHOD_SIG_RE.test(code) ||
        BARE_SIG_RE.test(code) || ARROW_OPEN_RE.test(code) ||
        FIELD_RE.test(code) || INTERFACE_MEMBER_RE.test(code) ||
        (!startsWithKeyword && TYPED_SIG_RE.test(code))

      if (looksDeclarative && !hasInlineBody(code)) {
        out.push({ category: "declaration", line })
        continue
      }

      out.push({ category: "statement", line })
    }

    return out
  }

  /**
   * Rules that are only safe inside one language. Returns null when no
   * language-specific rule applies, so the caller falls through to the
   * strict generic path.
   */
  function classifyForLang(code: string, lang: Lang): Category | null {
    if (lang === "sql") {
      if (SQL_SEPARATOR_RE.test(code)) return "structural"
      if (SQL_PRAGMA_RE.test(code)) return "structural"
      if (SQL_STATEMENT_RE.test(code)) return null // falls through -> statement
      if (SQL_DDL_RE.test(code)) return "declaration"
      if (SQL_COLUMN_RE.test(code)) return "declaration"
      return null
    }

    if (lang === "go") {
      if (GO_IMPORT_MEMBER_RE.test(code)) return "import"
      if (STATEMENT_KEYWORD_RE.test(code)) return null
      if (GO_IFACE_RE.test(code)) return "declaration"
      if (!/[(){}=.]/.test(code) && BARE_FIELD_RE.test(code)) return "declaration"
      return null
    }

    if (lang === "c") {
      if (STATEMENT_KEYWORD_RE.test(code)) return null
      if (!/[(){}=.]/.test(code) && BARE_FIELD_RE.test(code)) return "declaration"
      return null
    }

    return null
  }

  /**
   * A body stand-in. Checked against the CODE part of the line only, so
   * a trailing `// TODO` on a real statement cannot launder it — that
   * line was already stripped to its code before we get here.
   *
   * CAUSE 7: the original version only fired after `throw`/`raise`, so
   * Rust's `unimplemented!()`, Kotlin's `TODO()`, Swift's `fatalError`
   * and Go's `panic("not implemented")` all counted as implementation.
   * A call-shaped stand-in is admitted only when it either takes NO
   * arguments or names one of the configured markers — otherwise
   * `panic("db is down")` would launder a real statement.
   */
  function isMarker(code: string, cfg: Config): boolean {
    const bare = code.replace(/[;,]+$/, "").trim()
    if (bare === "pass" || bare === "..." || bare === "…") return true

    const namesMarker = (s: string): boolean => {
      const lower = s.toLowerCase()
      for (const m of cfg.markers) {
        if (lower.includes(m.toLowerCase())) return true
      }
      return false
    }

    if (/^(throw|raise)\b/i.test(bare)) return namesMarker(bare)

    // Go and Rust have no `throw`: the stand-in for an unwritten body is
    // `return nil, errors.New("not implemented")`. That is the exact
    // analogue of the `throw new Error("not implemented")` admitted just
    // above, so refusing it would be an accident of syntax rather than a
    // decision. Kept narrow on purpose — the line must BOTH name a
    // configured marker AND construct an error, so `return
    // computeTotal(items)` and `return nil, errors.New("db down")` are
    // still statements.
    if (/^return\b/i.test(bare) && !bare.includes("=") && namesMarker(bare)) {
      if (/\b(?:errors\.New|fmt\.Errorf|Errorf|NewError|Err|anyhow!|bail!)\s*\(/.test(bare)) {
        return true
      }
    }

    // Macro-shaped stand-ins: unimplemented!(), todo!(), TODO("...").
    if (/^(?:unimplemented|todo|unreachable|notImplemented)\s*!?\s*\(/i.test(bare)) return true

    // Call-shaped stand-ins, admitted only when empty or marker-named.
    const call = bare.match(/^(?:fatalError|panic|abort|notImplemented|NotImplemented)\s*\((.*)\)$/i)
    if (call) {
      const args = (call[1] ?? "").trim()
      return args === "" || namesMarker(args)
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

  export function countStatements(
    content: string,
    cfg: Config = DEFAULT_CONFIG,
    lang: Lang = "generic",
  ): number {
    let total = 0
    for (const r of classify(content, cfg, lang)) {
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
    lang: Lang = "generic",
  ): string[] {
    const out: string[] = []
    for (const r of classify(content, cfg, lang)) {
      if (r.category !== "statement") continue
      const t = r.line.trim()
      out.push(t.length > 60 ? t.slice(0, 57) + "..." : t)
      if (out.length >= limit) break
    }
    return out
  }
}
