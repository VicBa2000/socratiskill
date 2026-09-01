/**
 * shape-languages.ts — false-positive probe for the shape checker.
 *
 * WHY THIS EXISTS. Every shape assert written so far uses TS, Python or
 * C# samples, because those are the languages the axis was designed
 * against. But `code_extensions` lists twenty extensions, and STATEMENT
 * is the residual category: any construct the classifier does not
 * recognize silently becomes an "executable statement" and, at level 3
 * where the allowance is 0, DENIES THE FILE. A language the regexes do
 * not speak is therefore not a small inaccuracy — it makes the level
 * unusable for that language.
 *
 * So this probe asks the opposite question from the security suite.
 * There we ask "can an implementation sneak through?". Here we ask
 * "does an HONEST SKELETON get through?" — a file a mentor at level 3
 * would legitimately hand the user to fill in.
 *
 * Each sample is a skeleton a human would accept as "structure only".
 * `expectStatements` is what the checker SHOULD report. A sample that
 * reports more than that is a FALSE POSITIVE: the agent is blocked from
 * scaffolding something it should be allowed to scaffold.
 */

import { ShapeCheck } from "../../scripts/shape-check"

interface Sample {
  lang: string
  path: string
  /** What a human reads this as: pure skeleton, or genuinely has bodies. */
  intent: "skeleton" | "has-bodies"
  expect: number
  content: string
}

const L = (...lines: string[]) => lines.join("\n")

const SAMPLES: Sample[] = [
  // ---------------------------------------------------------------- TS
  {
    lang: "TypeScript",
    path: "src/auth/session.ts",
    intent: "skeleton",
    expect: 0,
    content: L(
      "import { db } from '../db'",
      "import type { User } from './types'",
      "",
      "export interface Session {",
      "  id: string",
      "  userId: string",
      "  expiresAt: Date",
      "}",
      "",
      "/** Create a session for a freshly authenticated user. */",
      "export function createSession(user: User): Promise<Session> {",
      "  // TODO: generate an id, compute the expiry, insert via db.",
      "  throw new Error('not implemented')",
      "}",
      "",
      "export function revokeSession(id: string): Promise<void> {",
      "  throw new Error('not implemented')",
      "}",
    ),
  },

  // ------------------------------------------------------------ Python
  {
    lang: "Python",
    path: "app/services/billing.py",
    intent: "skeleton",
    expect: 0,
    content: L(
      "from decimal import Decimal",
      "from typing import Protocol",
      "",
      "",
      "class PaymentGateway(Protocol):",
      "    def charge(self, amount: Decimal, token: str) -> str:",
      "        ...",
      "",
      "",
      "class BillingService:",
      "    def __init__(self, gateway: PaymentGateway) -> None:",
      "        pass",
      "",
      "    def charge_invoice(self, invoice_id: int) -> str:",
      "        # TODO: look up the invoice, sum the lines, call the gateway.",
      "        raise NotImplementedError",
    ),
  },

  // ---------------------------------------------------------------- C#
  {
    lang: "C#",
    path: "Services/OrderService.cs",
    intent: "skeleton",
    expect: 0,
    content: L(
      "using System;",
      "using System.Threading.Tasks;",
      "",
      "namespace Shop.Services",
      "{",
      "    public interface IOrderService",
      "    {",
      "        Task<Order> PlaceAsync(Cart cart);",
      "        Task CancelAsync(Guid orderId);",
      "    }",
      "",
      "    public class OrderService : IOrderService",
      "    {",
      "        public Task<Order> PlaceAsync(Cart cart)",
      "        {",
      "            // TODO: validate stock, reserve it, persist the order.",
      "            throw new NotImplementedException();",
      "        }",
      "    }",
      "}",
    ),
  },

  // --------------------------------------------------------------- SQL
  // The known rough edge. A CREATE TABLE is structure by any reading.
  {
    lang: "SQL (DDL)",
    path: "migrations/001_create_orders.sql",
    intent: "skeleton",
    expect: 0,
    content: L(
      "-- Orders and their line items.",
      "CREATE TABLE orders (",
      "    id          BIGINT PRIMARY KEY,",
      "    customer_id BIGINT NOT NULL,",
      "    status      VARCHAR(32) NOT NULL,",
      "    created_at  TIMESTAMP NOT NULL",
      ");",
      "",
      "CREATE INDEX ix_orders_customer ON orders (customer_id);",
    ),
  },
  {
    lang: "SQL (stored proc)",
    path: "procs/usp_place_order.sql",
    intent: "skeleton",
    expect: 0,
    content: L(
      "CREATE PROCEDURE usp_PlaceOrder",
      "    @CustomerId BIGINT,",
      "    @CartId     BIGINT",
      "AS",
      "BEGIN",
      "    -- TODO: validate the cart, reserve stock, insert the order.",
      "    SET NOCOUNT ON;",
      "END",
    ),
  },

  // ---------------------------------------------------------------- Go
  {
    lang: "Go",
    path: "internal/store/user.go",
    intent: "skeleton",
    expect: 0,
    content: L(
      "package store",
      "",
      "import (",
      '    "context"',
      '    "errors"',
      ")",
      "",
      "// UserStore persists users.",
      "type UserStore interface {",
      "    ByID(ctx context.Context, id int64) (*User, error)",
      "    Create(ctx context.Context, u *User) error",
      "}",
      "",
      "type User struct {",
      "    ID    int64",
      "    Email string",
      "}",
      "",
      "func (s *sqlStore) ByID(ctx context.Context, id int64) (*User, error) {",
      "    // TODO: query the users table and scan into a User.",
      "    return nil, errors.New(\"not implemented\")",
      "}",
    ),
  },

  // -------------------------------------------------------------- Rust
  {
    lang: "Rust",
    path: "src/parser.rs",
    intent: "skeleton",
    expect: 0,
    content: L(
      "use std::collections::HashMap;",
      "",
      "/// A parsed configuration document.",
      "pub struct Config {",
      "    pub entries: HashMap<String, String>,",
      "}",
      "",
      "pub trait Parse {",
      "    fn parse(input: &str) -> Result<Config, ParseError>;",
      "}",
      "",
      "impl Parse for Config {",
      "    fn parse(input: &str) -> Result<Config, ParseError> {",
      "        // TODO: tokenize, then fold the tokens into entries.",
      "        unimplemented!()",
      "    }",
      "}",
    ),
  },

  // -------------------------------------------------------------- Java
  {
    lang: "Java",
    path: "src/main/java/shop/OrderRepository.java",
    intent: "skeleton",
    expect: 0,
    content: L(
      "package shop;",
      "",
      "import java.util.List;",
      "import java.util.Optional;",
      "",
      "public interface OrderRepository {",
      "    Optional<Order> findById(long id);",
      "    List<Order> findByCustomer(long customerId);",
      "    void save(Order order);",
      "}",
    ),
  },

  // -------------------------------------------------------------- Ruby
  {
    lang: "Ruby",
    path: "app/services/invoice_builder.rb",
    intent: "skeleton",
    expect: 0,
    content: L(
      "module Billing",
      "  class InvoiceBuilder",
      "    def initialize(account)",
      "      # TODO: keep the account for later.",
      "      raise NotImplementedError",
      "    end",
      "",
      "    def build(period)",
      "      raise NotImplementedError",
      "    end",
      "  end",
      "end",
    ),
  },

  // --------------------------------------------------------------- PHP
  {
    lang: "PHP",
    path: "src/Repository/UserRepository.php",
    intent: "skeleton",
    expect: 0,
    content: L(
      "<?php",
      "",
      "namespace App\\Repository;",
      "",
      "interface UserRepository",
      "{",
      "    public function findById(int $id): ?User;",
      "    public function save(User $user): void;",
      "}",
    ),
  },

  // ------------------------------------------------------------ Kotlin
  {
    lang: "Kotlin",
    path: "src/main/kotlin/Repo.kt",
    intent: "skeleton",
    expect: 0,
    content: L(
      "package com.example.data",
      "",
      "import kotlinx.coroutines.flow.Flow",
      "",
      "interface UserRepo {",
      "    suspend fun byId(id: Long): User?",
      "    fun observeAll(): Flow<List<User>>",
      "}",
      "",
      "data class User(",
      "    val id: Long,",
      "    val email: String,",
      ")",
    ),
  },

  // ------------------------------------------------------------- Swift
  {
    lang: "Swift",
    path: "Sources/Networking/Client.swift",
    intent: "skeleton",
    expect: 0,
    content: L(
      "import Foundation",
      "",
      "protocol APIClient {",
      "    func get(_ path: String) async throws -> Data",
      "}",
      "",
      "struct URLSessionClient: APIClient {",
      "    func get(_ path: String) async throws -> Data {",
      "        // TODO: build the URL, run the request, validate the status.",
      "        fatalError(\"not implemented\")",
      "    }",
      "}",
    ),
  },

  // ------------------------------------------------------------- C/C++
  {
    lang: "C header",
    path: "include/ringbuf.h",
    intent: "skeleton",
    expect: 0,
    content: L(
      "#ifndef RINGBUF_H",
      "#define RINGBUF_H",
      "",
      "#include <stddef.h>",
      "",
      "typedef struct ringbuf ringbuf_t;",
      "",
      "ringbuf_t *ringbuf_new(size_t capacity);",
      "void ringbuf_free(ringbuf_t *rb);",
      "int ringbuf_push(ringbuf_t *rb, int value);",
      "",
      "#endif",
    ),
  },

  // ---------------------------------------------------- CONTROL GROUP
  // These SHOULD report statements. If they come back 0 the checker has
  // a hole, which is the security suite's question, asked here so the
  // probe cannot pass by simply reporting 0 for everything.
  {
    lang: "TypeScript (real impl)",
    path: "src/util/slug.ts",
    intent: "has-bodies",
    expect: 4,
    content: L(
      "export function slug(input: string): string {",
      "  const lower = input.toLowerCase()",
      "  const stripped = lower.replace(/[^a-z0-9]+/g, '-')",
      "  const trimmed = stripped.replace(/^-|-$/g, '')",
      "  return trimmed",
      "}",
    ),
  },
  {
    lang: "Python (real impl)",
    path: "app/util/total.py",
    intent: "has-bodies",
    expect: 3,
    content: L(
      "def total(items):",
      "    running = 0",
      "    for it in items:",
      "        running += it.price",
      "    return running",
    ),
  },
]

let fp = 0
let fn = 0
const rows: string[] = []

for (const s of SAMPLES) {
  const cls = ShapeCheck.classifyFile(s.path)
  const lang = ShapeCheck.languageOf(s.path)
  const got = cls === "markup" ? 0 : ShapeCheck.countStatements(s.content, ShapeCheck.DEFAULT_CONFIG, lang)
  const verdictL3 = got > 0 ? "DENIED" : "allowed"
  let flag = "ok"
  if (s.intent === "skeleton" && got > s.expect) {
    flag = "FALSE POSITIVE"
    fp++
  } else if (s.intent === "has-bodies" && got === 0) {
    flag = "FALSE NEGATIVE"
    fn++
  }
  rows.push(
    [
      s.lang.padEnd(24),
      cls.padEnd(7),
      String(got).padStart(3),
      verdictL3.padEnd(8),
      flag,
    ].join("  "),
  )
  if (flag === "FALSE POSITIVE") {
    for (const line of ShapeCheck.statementSamples(s.content, 8, ShapeCheck.DEFAULT_CONFIG, lang)) {
      rows.push("      -> " + line)
    }
  }
}

console.log("")
console.log("LANGUAGE                  class   stmt  L3        verdict")
console.log("-".repeat(70))
for (const r of rows) console.log(r)
console.log("-".repeat(70))
console.log(`false positives (honest skeleton denied): ${fp}`)
console.log(`false negatives (implementation allowed): ${fn}`)
console.log("")

process.exit(fp > 0 || fn > 0 ? 1 : 0)
