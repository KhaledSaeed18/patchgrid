# 0009 — Per-type ticket numbers from a counter table

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

Humans refer to tickets by number (`INC-000042`), and the number is used in email subjects for threading. Numbers must be unique, gap-free enough not to look broken, and safe under concurrent creation.

## Options considered

1. **Postgres sequence per type** — fast, gap-tolerant (rollbacks skip numbers); Prisma schema cannot declare multiple sequences per table cleanly, and per-org sequences would need DDL at runtime.
2. **`MAX(number) + 1`** — race-prone unless serialized; naive.
3. **`TicketCounter(orgId, type, nextValue)` row updated with `UPDATE … SET nextValue = nextValue + 1 RETURNING` inside the ticket-creation transaction** — row lock serializes creates per `(org, type)`, no gaps, trivially portable, visible in the schema.

## Decision

Option 3, done in the ticket repository inside the same transaction that inserts the ticket. Display format `<PREFIX>-<6-digit zero-padded>` with prefixes `INC`, `SR`, `PRB`, `CHG`. The database stores the integer `number` and the type; the string is derived (a contract helper `formatTicketNumber`). Unique index on `(orgId, type, number)`. Numbering is **per organization**: two tenants both have an `INC-000001`, which is correct and expected (ADR-0013).

## Consequences

- Ticket creation for one type is serialized per org. At IT-desk volumes (dozens per hour) this is irrelevant; it would only matter at thousands per second.
- Email intake can parse `[INC-000042]` from a subject deterministically.
- Search accepts either the id or the formatted number.
