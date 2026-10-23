# 0048 — The roadmap after M10: four architecture milestones before M7

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** `FEATURES.md` (build order, out-of-scope list)

> **Erratum (2026-10-23).** "And then M7" no longer holds: M7 is dropped ([0056](0056-m7-dropped.md)),
> and the build order ends at M14.

## Context

M10 closed without a public deployment (ADR-0047). The product works end to end and M7, the models, was
always meant to come last. The time that hosting would have taken is better spent where a learning
project earns most: problems a CRUD application never meets, solved on a system that already has real
tenancy, authorization and jobs to constrain the solutions.

The candidates were weighed against three questions. Does it close a known weakness in what is built?
Is the technique transferable, i.e. something real systems are built on? Can it be exercised, tested and
measured locally, for free?

## Decision

Four milestones, built in this order, and then M7:

1. **M11 — Reliable delivery.** A transactional outbox read as a per-tenant log, with consumer cursors
   and dead letters; per-tenant fairness in draining it; outbound webhooks on top. It closes a real gap:
   today a side effect is queued *after* commit, so a crash between the two loses it and a retry can
   repeat it (`HANDOFF.md`, "requester receipt can repeat"). Delivery guarantees, idempotent consumers,
   ordering and noisy-neighbour fairness are the most transferable topics on the list.
2. **M12 — Insight.** Reporting as a read side kept apart from the write side: SLA compliance, time to
   resolve, backlog age and workload, built by a consumer of M11's log, not by aggregate queries over the
   live tables. Saved views and bulk actions, which put the permission model and optimistic concurrency
   under load at once.
3. **M13 — Identity.** Passkeys (WebAuthn) as a first factor and as the step-up proof, and per-tenant
   OIDC single sign-on against a local Keycloak, routed by verified email domain, which uses the
   domain the workspace already stores (`TENANCY.md` §5).
4. **M14 — Production rehearsal, locally.** The production compose file behind Caddy with locally trusted
   wildcard TLS, PgBouncer in transaction mode, and a streaming replica that reads may be routed to. It
   proves on a laptop most of what ADR-0047 gave up, and it puts the transaction-local tenant setting
   (ADR-0015) to the test it was designed for.

Then **M7**, unchanged.

**Out-of-scope changes.** Outbound webhooks and per-tenant OIDC move into scope. SAML, SCIM, custom
roles, a workflow DSL and Kubernetes stay out. Each one is either a second implementation of something
these milestones already teach, or infrastructure with nothing to say about this domain.

**Considered and not chosen.** Event sourcing of tickets: M11's log gives replay and history without
rebuilding the write side around it, and doing both would be two answers to one question. A policy
engine (Cedar/OPA): `PermissionService.can()` is already pure and matrix-tested, so the gain would be
syntax. Real-time co-editing with CRDTs: a large client-side investment for a form-shaped product.
Citus sharding: nothing in the data volume asks for it, and M14's pooling and replica cover the
operational lessons.

## Consequences

- M11 changes how every ticket notification travels. It is the riskiest of the four and goes first,
  while the suites that would catch a regression are freshest.
- Each milestone writes its own "as built" ADRs, as M8 and M9 did.
- M12 depends on M11's log. M13 and M14 depend on nothing new and could swap places.
