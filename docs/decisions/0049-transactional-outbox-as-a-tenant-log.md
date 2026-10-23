# 0049 — A transactional outbox, read as a per-tenant log below the snapshot horizon

- **Status:** Accepted
- **Date:** 2026-10-17
- **Refines:** [0018](0018-tenant-aware-jobs-and-events.md), which put side effects after commit as queued jobs

> **Erratum (2026-10-17, the M11 review).** "Effects outside the database (email, the live stream, later
> an HTTP call) run after that commit and are at-least-once" is true of webhooks, whose deliveries are
> rows a sweep re-queues, and not of email: it is queued in-process after the cursor commits, so a crash
> or a Redis refusal at that instant loses it. Email is **best effort** until a `mail` consumer of the log
> exists. The column this ADR calls `txId` is `txn` in the schema. As built after the review, an event's
> failures back off on the cursor (2 s, 8 s, 32 s) before it is parked, and a deadlock, serialization
> failure or timeout is retried as the job's own failure without counting against the event
> (THREAT-MODEL §8).

> **Erratum (2026-10-23).** Notification email is at least once now, without a separate `mail`
> consumer. The `notify` consumer queues its emails **inside** the transaction that moves its cursor:
> a queue that refuses throws a `TransientFailure`, the batch (inbox rows included) rolls back, and the
> drain is retried as the job's failure, never counted against the event. A commit that fails after the
> queue accepted can send an email twice; each job's id is the event and the person, so a duplicate is
> refused while the first is still queued. A separate consumer would have had to recompute who gets
> an email from rows the `notify` consumer may or may not have written yet.

## Context

Since M3 a service commits its change and *then* queues what should follow: a `notify` job on BullMQ,
whose job id makes a retried request notify once. Two failures sit in the gap between the commit and the
queue:

- **Loss.** The process dies, or Redis refuses the write, after Postgres committed. The ticket moved and
  nobody hears of it. `Notifier.notifyAll` logs and swallows the error, because turning a committed
  change into a 500 would be worse.
- **Repetition.** The job id deduplicates only while BullMQ still holds the job. Completed jobs are
  removed, so a retry that comes later runs again (`HANDOFF.md`, "requester receipt can repeat").

Both are the dual-write problem: two systems, no transaction spanning them. M11's webhooks and M12's
read side would inherit it, so it is fixed first.

## Decision

### The event is written in the change's transaction

`OutboxEvent` is a tenant-owned table. A service appends its events **inside the transaction that makes
the change**, so the event exists if and only if the change does. There is no second system to fail
in between. The table has RLS, `orgId`-first indexes and composite keys like every other tenant table.

Each row records the id of the transaction that wrote it: `txId`, `pg_current_xact_id()` as a
`bigint`.

### Consumers read it as a log, with cursors

The outbox is not drained into a queue and forgotten. It is a **per-tenant log** that each consumer reads
at its own pace: `notify` now, `webhooks` and `reporting` later. `EventConsumer (orgId, consumer)` holds
the consumer's cursor `(txId, id)`. A new consumer starts at the beginning and can be replayed by moving
its cursor back. That is what lets M12 build a read side from history that already exists.

### Why the order is the transaction id, and the horizon

The obvious cursor, "everything after the last id I read", is wrong. Ids (UUID v7) and sequences are
assigned when a row is **inserted**, but rows become visible when their transaction **commits**, and the
two orders differ. Transaction A inserts id 5, transaction B inserts id 6 and commits, a reader takes 6
and moves its cursor past 5. A commits, and event 5 is never read.

So the log is read in `(txId, id)` order, and **only below the snapshot horizon**:

```sql
WHERE ("txId", "id") > (cursor) AND "txId" < pg_snapshot_xmin(pg_current_snapshot())
```

`pg_snapshot_xmin` is the oldest transaction still running. Every transaction older than it has either
committed or aborted, so no event below the horizon can still appear. A reader that respects it never
moves its cursor past an event that commits later. When events exist above the horizon, the drain
reschedules itself a moment later instead of waiting for the next wake.

**The price, stated honestly:** the horizon is cluster-wide. A long transaction anywhere, in any tenant,
holds every consumer back until it ends. Transactions here are short by rule (`ENGINEERING.md`), and the
per-tenant lag metric will show it if that changes.

### Exactly once where it can be, at least once where it cannot

A consumer's handler runs **in the same transaction that advances its cursor**. Its database effects
(the `notify` consumer writes inbox rows) therefore happen exactly once: commit both or neither.
Effects outside the database (email, the live stream, later an HTTP call) run after that commit and are
at-least-once, made safe by deterministic ids downstream. No pattern makes a remote side effect
exactly-once. The design is honest about where the line falls.

### Waking, draining, and fairness

- **Wake on commit.** A statement-level trigger on `OutboxEvent` calls `pg_notify('patchgrid_outbox',
  orgId)`. Postgres delivers notifications **only on commit**, so a rolled-back change wakes nobody. One
  listening connection per worker turns notifications into drain requests.
- **One waiting drain per tenant and consumer.** A drain request sets a Redis flag with `SET NX` and
  enqueues only if it won. The drain clears the flag **when it starts**, not when it finishes. A wake that
  arrives mid-drain therefore enqueues another drain that will start after it, and no wake is lost.
  BullMQ's own deduplication holds the id until the job *completes*, which would drop exactly that wake.
- **Draining is serialised per tenant and consumer** by `pg_try_advisory_xact_lock`. A drain that loses
  the lock reschedules itself instead of blocking a pooled connection. An advisory lock assigns no
  transaction id, so the drainer does not hold back its own horizon before it reads.
- **Bounded batches, then yield.** A drain takes at most a batch, commits, and if more remains, enqueues
  its successor at the back of the queue. Tenants with a backlog are served round-robin, so one tenant's
  flood costs another a batch's latency, not the flood's.
- **A sweep is the safety net.** The dispatcher's `outbox-sweep` asks for a drain per tenant every
  minute, in case a notification was missed while no listener was connected.

### Poison events

A batch whose handler throws rolls back. The drain then retries the batch one event at a time, each in
its own transaction, until it finds the event that fails. It records the failure on the cursor and
throws, so BullMQ backs off. After `OUTBOX_MAX_FAILURES` failures of the same event, the event is
**parked** in `EventDeadLetter` with its error and the cursor moves past it. One bad event costs its
consumer a few retries, never the tenant's stream.

## Consequences

- Ticket notifications no longer go through the `notify` queue. They are written by the drain, in the
  cursor's transaction. The live stream and email follow the commit as before.
- The live-stream "ticket changed" pulse stays a direct, best-effort hint after commit: its purpose is
  latency, and a lost pulse costs a stale screen until the next refetch.
- Events accumulate. Retention deletes what every cursor has passed, past a window, and never ahead of a
  cursor (M11).
- Account mail (verification, invitations, password reset) stays as it is. It belongs to no tenant
  event, and its idempotency is the token's own.
- The relay is more machinery than "enqueue after commit": a trigger, a listener, cursors, a lock and a
  flag. Each piece closes a named failure, and the integration specs reproduce each failure.
