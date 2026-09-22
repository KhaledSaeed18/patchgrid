# 0008 — Server-Sent Events for live in-app notifications

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

Agents should see assignments, replies, and SLA warnings without refreshing. Traffic is one-directional (server → client) and low-volume.

## Options considered

1. **Polling** `/notifications?since=` every N seconds — simplest; N seconds of latency, constant load, feels cheap.
2. **WebSockets** (`@nestjs/websockets` + socket.io) — bidirectional; more infrastructure (sticky sessions or a Redis adapter when scaling), heavier client, not needed for one-way traffic.
3. **Server-Sent Events** — native `EventSource` in the browser, auto-reconnect with `Last-Event-ID`, plain HTTP, first-class in NestJS via `@Sse()`. One-directional, which is all we need.

## Decision

SSE. `GET /api/v1/notifications/stream` authenticates from the cookie and pushes `notification` events (`id`, `type`, `ticketId`, `title`) and a `ticket-updated` event (`ticketId`, `updatedAt`) for tickets the user is watching (requester, assignee, or team member). Delivery is fan-out through a Redis pub/sub channel so multiple API instances work later; in a single process it is an in-memory subject behind the same interface.

## Consequences

- The client uses `Last-Event-ID` on reconnect; missed events are recovered from the `Notification` table, so SSE is a hint, not the source of truth.
- Heartbeat comment every 25 s keeps proxies from closing idle streams.
- If interactivity ever needs client → server messages (typing indicators, collaborative editing), that is a new ADR for WebSockets; nothing here blocks it.
