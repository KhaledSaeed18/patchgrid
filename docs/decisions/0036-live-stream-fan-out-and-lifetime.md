# 0036 — Live stream: who hears a ticket change, and how long a stream lives

- **Status:** Accepted
- **Date:** 2026-10-14
- **Refines:** [0008](0008-sse-for-in-app-notifications.md) — the `ticket-updated` audience and the stream's lifetime

## Context

ADR-0008 chose SSE and named two events: `notification`, for one recipient, and `ticket-updated`, "for
tickets the user is watching (requester, assignee, or team member)". Building it in M3 raised three
questions the ADR leaves open:

- **Who gets `ticket-updated`?** "Watching" covers the ticket page. It does not cover the console queues,
  which also show tickets that change. `DOMAIN.md` §8 says the fan-out applies the same `scopeFor()`
  filter as a list query, which makes the readers of a ticket the natural audience.
- **On whose facts is the fan-out decided, and when?** A stream is long-lived. The role and teams it
  was opened with can go stale while it runs. Re-reading them for every event, on every instance, is
  I/O on the hot path of every change.
- **How long may a stream live?** A cookie-authenticated request is checked once, at the start. A
  stream that outlives its access token, or the membership change that should have ended it, keeps
  delivering on an authorization nobody would grant any more.

## Options considered

1. **`ticket-updated` to watchers only, reader facts re-read per event.** Matches ADR-0008's wording, but
   the queues get no live updates, and each event costs a query per open stream.
2. **`ticket-updated` to every reader, decided from facts carried in the event; the stream's own facts
   fixed at open and bounded by the credential.** One read per change, no I/O per stream, and staleness
   bounded by the token's lifetime and the revocation epoch.
3. **Push a per-member event list from the writer.** The writer would have to know every open stream,
   which belongs to another process.

## Decision

Option 2.

- **Audience.** `ticket-updated` reaches every open stream whose member may read the ticket. "May read"
  is `TicketAudience.mayRead`: the subject `TicketAccess` builds for a `GET`, the same `scopeFor()`
  branches through `ticketInScope`, and the same `can("ticket:read")`. An authz-suite spec holds the two
  equal for every role × visibility × relationship × team placement. The client uses the event only to
  refetch. It carries a ticket id and a timestamp, nothing else.
- **Facts in the event.** The bus message carries the ticket's scope columns, its explicit watchers and
  the workspace's agent visibility, read once after commit. Every instance decides each local stream
  with no I/O. A change to an internal note is marked `internal` and needs `comment:read_internal` as
  well, because the fact that a note was written is not something a requester may learn. The message is
  internal and never reaches a browser as is.
- **Notifications** are filtered when the row is written (the same `mayRead`, plus
  `comment:read_internal` for an internal note) and go to one membership only.
- **Lifetime.** A stream ends at the earlier of its access token's `exp` and 30 minutes. Every 25-second
  heartbeat asks `StandingService` whether the session still stands. That means the revocation epoch
  against the token's `iat`, then the membership re-read inside its tenant, and the stream decides on the
  role and teams that read returns. A member who loses access stops hearing within one heartbeat. This
  holds even when the epoch bump ran before its transaction committed and a token was refreshed in the
  gap. A database that cannot answer ends the stream, and the client's reconnect decides afresh. Redis
  being unreachable leaves the epoch unknown, and the read decides alone: reads stay open, as ADR-0024
  decides for requests. One member holds at most five streams per instance; a sixth ends the oldest.
- **Bus.** Redis pub/sub on `org:<orgId>:notifications`. A process subscribes to a tenant's channel
  only while it holds a stream for that tenant. A listener is registered against one org and is only
  ever called with messages from that org's channel.
- **Replay.** `Last-Event-ID` is a notification id. A reconnect replays this member's rows written or
  folded into after that row's `updatedAt`, oldest first, capped at 50. Replay is best effort, because
  a row that commits late can fall behind the mark. So the client also re-reads the inbox whenever a
  stream opens. The table stays the source of truth.

## Consequences

- An `ALL_TICKETS` agent's stream carries every ticket change in the workspace. That is fine for the
  ~30-person desks this product targets. A large tenant would want per-view subscriptions, which is a
  new ADR.
- A running stream's facts are at most one heartbeat old. An `agentVisibility` change is carried in the
  event rather than held by the stream, so it takes effect at the next change. Suspending an
  organization has no code path yet (M8). When it does, it must bump the epoch of every member.
- Each heartbeat is one indexed read and one logged `runAsTenant` crossing per stream. At hundreds of
  concurrent streams per instance, the crossing log wants sampling.
- Sweeps (SLA scan, auto-close) send notifications but no `ticket-updated`. A sweep touching hundreds of
  tickets would otherwise be hundreds of reads. Recipients refetch through the notification event.
