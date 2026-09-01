/**
 * shape-why.ts — line-level contract for the shape recognizer.
 *
 * shape-languages.ts asks whether a whole skeleton survives. This file
 * asks the sharper question, one line at a time: does THIS construct
 * count as a body?
 *
 * It is the guardrail for the post-v0.5.1 widening. Making the
 * recognizer speak eleven more languages meant adding loose patterns,
 * and every loose pattern is a potential hole in Layer 1. The MUST-BE-
 * STATEMENT block below is what proves the widening did not become one:
 * if a future edit makes `INSERT INTO ...` or `return computeTotal(x)`
 * look like a declaration, this fails loudly instead of silently
 * letting the agent write the user's code.
 *
 * Adding a language to ShapeCheck.Lang REQUIRES adding its statements
 * here too. A relaxation with no matching guardrail is how Layer 1 dies.
 */

import { ShapeCheck } from "../../scripts/shape-check"

type Lang = ShapeCheck.Lang

/** [label, line, language, must-not-be-a-statement] */
type Case = [string, string, Lang, boolean]

const SKELETON: Case[] = [
  // CAUSE 1 — modifiers the declaration regex did not know
  ["Rust visibility", "pub struct Config {", "rust", true],
  ["Rust trait", "pub trait Parse {", "rust", true],
  ["Kotlin coroutine", "suspend fun byId(id: Long): User?", "kotlin", true],
  ["Kotlin plain fun", "fun observeAll(): Flow<List<User>>", "kotlin", true],
  ["Kotlin data class", "data class User(", "kotlin", true],

  // CAUSE 2 — declaration keywords that were missing
  ["Swift protocol", "protocol APIClient {", "swift", true],
  ["C typedef", "typedef struct ringbuf ringbuf_t;", "c", true],
  ["Rust impl", "impl Parse for Config {", "rust", true],
  ["Swift extension", "extension String {", "swift", true],

  // CAUSE 3 — fields declared `Name Type`, no colon
  ["Go struct field", "ID    int64", "go", true],
  ["Go struct field 2", "Email string", "go", true],

  // CAUSE 4 — field prefix the field regex did not know
  ["Rust struct field", "pub entries: HashMap<String, String>,", "rust", true],

  // CAUSE 5 — pointer and multi-value signatures
  ["C prototype", "ringbuf_t *ringbuf_new(size_t capacity);", "c", true],
  ["Go iface member", "ByID(ctx context.Context, id int64) (*User, error)", "go", true],
  ["Go iface member 2", "Create(ctx context.Context, u *User) error", "go", true],

  // CAUSE 6 — word terminators and language preamble
  ["Ruby end", "end", "ruby", true],
  ["SQL begin", "BEGIN", "sql", true],
  ["SQL end", "END", "sql", true],
  ["SQL as", "AS", "sql", true],
  ["PHP open tag", "<?php", "php", true],
  ["Go import member", '"context"', "go", true],

  // CAUSE 7 — body stand-ins that are not throw/raise
  ["Rust macro marker", "unimplemented!()", "rust", true],
  ["Rust todo macro", "todo!()", "rust", true],
  ["Swift marker", 'fatalError("not implemented")', "swift", true],
  ["Go marker", 'panic("not implemented")', "go", true],
  ["Kotlin marker", 'TODO("not implemented")', "kotlin", true],
  ["Go return marker", 'return nil, errors.New("not implemented")', "go", true],

  // CAUSE 8 — SQL DDL
  ["SQL create table", "CREATE TABLE orders (", "sql", true],
  ["SQL column", "id          BIGINT PRIMARY KEY,", "sql", true],
  ["SQL column 2", "status      VARCHAR(32) NOT NULL,", "sql", true],
  ["SQL create index", "CREATE INDEX ix_orders_customer ON orders (customer_id);", "sql", true],
  ["SQL create proc", "CREATE PROCEDURE usp_PlaceOrder", "sql", true],
  ["SQL proc param", "@CustomerId BIGINT,", "sql", true],
  ["SQL pragma", "SET NOCOUNT ON;", "sql", true],
  ["SQL alter", "ALTER TABLE orders ADD COLUMN note TEXT;", "sql", true],
]

/**
 * THE GUARDRAIL. Every line here is real logic and MUST keep consuming
 * budget. These are checked under the language whose rules are loosest
 * for that shape, which is the case that matters — a statement is only
 * dangerous where a relaxation could swallow it.
 */
const MUST_COUNT: Case[] = [
  ["real return", "return computeTotal(items)", "generic", false],
  ["real assign", "const x = compute()", "generic", false],
  ["real call", "db.insert(order)", "generic", false],
  ["bare call", "doWork()", "generic", false],
  ["go return", 'return nil, errors.New("boom")', "go", false],
  ["go assign", "total := 0", "go", false],
  ["go call", "s.db.Exec(query)", "go", false],
  ["go append", "out = append(out, v)", "go", false],
  ["c assign", "int total = compute(x);", "c", false],
  ["c call", "free(buf);", "c", false],
  ["sql insert", "INSERT INTO orders (id) VALUES (1);", "sql", false],
  ["sql update", "UPDATE orders SET status = 'paid' WHERE id = @Id;", "sql", false],
  ["sql select", "SELECT id, status FROM orders WHERE customer_id = @Cid;", "sql", false],
  ["sql delete", "DELETE FROM orders WHERE id = @Id;", "sql", false],
  ["sql exec", "EXEC usp_ReserveStock @CartId;", "sql", false],
  ["sql merge", "MERGE INTO stock AS t USING src AS s ON t.id = s.id", "sql", false],
  ["ruby call", "puts total", "ruby", false],
  ["ruby assign", "total = items.sum(&:price)", "ruby", false],
  ["rust let", "let total = items.iter().sum();", "rust", false],
  ["kotlin assign", "val total = items.sumOf { it.price }", "kotlin", false],
  ["swift call", "session.resume()", "swift", false],
  ["panic real", 'panic("db is down")', "go", false],
  ["fatal real", 'fatalError("bad state")', "swift", false],
  ["throw real", 'throw new Error("db is down")', "generic", false],
  ["php call", "$repo->save($user);", "php", false],
]

let failures = 0
const show = (cases: Case[], title: string) => {
  console.log("")
  console.log(title)
  console.log("-".repeat(78))
  for (const [name, line, lang, mustNotCount] of cases) {
    const cat = ShapeCheck.classify(line, ShapeCheck.DEFAULT_CONFIG, lang)[0]!.category
    const isStatement = cat === "statement"
    const bad = mustNotCount ? isStatement : !isStatement
    if (bad) failures++
    const tag = bad ? (mustNotCount ? "  <-- FALSE POSITIVE" : "  <-- HOLE") : ""
    console.log(`${name.padEnd(20)} ${lang.padEnd(8)} ${cat.padEnd(12)} ${line.trim()}${tag}`)
  }
}

show(SKELETON, "SKELETON — must NOT be a statement")
show(MUST_COUNT, "LOGIC — must be a statement (this is the guardrail)")

console.log("-".repeat(78))
console.log(failures === 0 ? "all line contracts hold" : `${failures} line contract(s) broken`)
console.log("")

process.exit(failures === 0 ? 0 : 1)
