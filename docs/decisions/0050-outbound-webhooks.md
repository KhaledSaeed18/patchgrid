# 0050 — Outbound webhooks: thin signed events, at least once, and nobody else's problem

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [0049](0049-transactional-outbox-as-a-tenant-log.md) (the log), [0021](0021-api-tokens-as-service-accounts.md) (the API a receiver calls back)

## Context

M11's last feature: a workspace subscribes an HTTPS endpoint to its events. Webhooks are where a
multi-tenant system makes outbound requests to addresses its customers choose. That means:

- A tenant names the URL, so the request can be aimed at our own network (SSRF).
- A slow or dead endpoint must cost its own tenant time, and nobody else's.
- Delivery fails routinely, so retries, an end to retrying, and a way to try again by hand are the
  feature, not an edge case.
- A receiver must be able to tell our requests from a forger's, and a database dump must not let
  anyone sign as us.

## Decision

### Thin events from a public catalogue

The payload carries **identifiers and states, never content**: the ticket's id, number, type, status
and priority; for a comment, its id and that it is public. No titles, descriptions or bodies. A receiver
that needs more calls the API with a token, where the scopes and the role decide what it may read
(ADR-0042). A webhook is therefore never a way around authorization, and a leaked delivery log leaks no
ticket text.

The public types are a stable, versioned catalogue in `@patchgrid/contracts`, mapped from the internal
log events: `ticket.created`, `ticket.assigned`, `ticket.status_changed`, `ticket.reopened`,
`comment.created`, `change.submitted`, `change.decided`, `ticket.sla_warning`, `ticket.sla_breached`.
Internal notes are not in it: they are `comment:read_internal`, which no integration holds by default
(RBAC.md §10). Renaming an internal event never changes the wire.

### Delivery is a second consumer of the log

The `webhooks` consumer reads the same tenant log as `notify`. For each event it writes one
`WebhookDelivery` row per active endpoint subscribed to its type, **in the transaction that moves its
cursor**, so each endpoint gets each event exactly once as a row. The HTTP attempts are jobs on
`webhook-deliver`, queued after that commit, and are **at least once**: a retry can repeat a request
the receiver already processed. Receivers deduplicate on `webhook-id`, which is the delivery's id and
the same across retries and replays.

### The Standard Webhooks signature

Headers per the Standard Webhooks specification, so receivers can use an existing library:
`webhook-id`, `webhook-timestamp` (seconds), and `webhook-signature: v1,<base64 HMAC-SHA256 of
"id.timestamp.body">`. The secret is `whsec_` and base64 of 24 random bytes, shown once at creation.

- **Rotation without downtime.** Rotating keeps the previous secret valid for 24 hours, and requests
  are signed with both (the header carries space-separated signatures).
- **At rest the secret is sealed, not hashed.** We must sign with it, so it cannot be a hash, and it
  is sealed with AES-256-GCM under `WEBHOOK_SECRETS_KEY`, kept apart from the database like the MFA key
  (ADR-0040). A dump alone signs nothing.

### Retries, an end, and replay

Attempts follow `0s, 5s, 5m, 30m, 2h, 5h, 10h`, each with ±20% jitter so a recovered receiver is not
hit by every retry at once. Only a `2xx` counts as delivered. A `3xx` is a failure: we never follow
redirects, because a redirect is a second, unvetted address. After the seventh failed attempt the
delivery is `DEAD`. An admin can replay a dead delivery, or every dead delivery of an endpoint, and a
replay resets its attempts. A sweep re-queues any `PENDING` delivery whose attempt is overdue, in case
its job was lost.

### A circuit breaker per endpoint

After 5 consecutive failures an endpoint's circuit **opens**: deliveries due while it is open move to
its reopening time without spending an attempt. The open period is 1 minute, doubling to an hour. The
first attempt after it is the probe: a success closes the circuit, a failure opens it again for twice
as long. An endpoint that has failed for 5 days without a success is **disabled**, on the audit log as
the system's doing, and the settings page says why. A dead endpoint costs its tenant one probe an hour instead of a stream of timeouts.

### SSRF: every address is checked, at the moment of connecting

- At save time the URL must be `https`, carry no credentials, and not name an IP literal in a blocked
  range.
- At send time the host is resolved, **every** address is checked against the blocked ranges (loopback,
  private, link-local including the cloud metadata address, CGNAT, multicast, reserved, the IPv6
  unique-local and link-local ranges, and IPv4 mapped into IPv6), and the connection goes to the
  vetted address. Checking a name and then letting the HTTP client resolve it again is the DNS
  rebinding hole. The check lives in the client's own `lookup` hook, so there is no second
  resolution.
- No redirects, a 10-second total timeout, and at most 4 KB of the response kept for the log.
- `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` lifts the address check, and `http` is allowed, for local
  development only; the config refuses it in production.

### Fairness

A tenant may have at most `N` deliveries in flight (2 on Free, 8 on Pro). The cap is a Redis lease set
per tenant, taken atomically by a Lua script, with each lease expiring so a crashed worker cannot hold
one forever. A delivery that finds the cap full is moved back to the delayed set for a moment, and does
not spend an attempt. One tenant's hundred slow endpoints therefore occupy at most `N` of the workers'
slots, never all of them.

### Who may manage webhooks

`webhook:manage`, held by admins and owners, covers endpoints, their deliveries, rotation and replay.
Every change to an endpoint is audited. **A token cannot manage webhooks.** A service account is at most
an agent (ADR-0042) and this is an admin's permission, so `webhooks:write` stays reserved. An
integration that could subscribe itself to every event would be a quiet exfiltration channel, and
setting one up is a person's decision.

## Consequences

- A receiver gets ids and calls back, which is one more request for it and no content in transit or in
  our logs.
- At-least-once means receivers must deduplicate. The documentation says so first.
- A new required secret, `WEBHOOK_SECRETS_KEY`, joins `MFA_ENCRYPTION_KEY` in the list of keys a backup
  must not carry.
- Deliveries reference their outbox event, so event retention can never delete an event a delivery
  still points to.
