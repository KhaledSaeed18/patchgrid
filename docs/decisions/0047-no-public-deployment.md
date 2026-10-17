# 0047 — No public deployment: Patchgrid runs locally, and the deployment design stays a design

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [0026](0026-wildcard-tls-and-dns-operations.md), [0027](0027-email-dns-and-inbound-sender-authentication.md), [0010](0010-ml-services-behind-interfaces-in-monorepo.md)

## Context

M10 ended with two items that cost money and an ongoing operator: DNS and TLS for `patchgrid.xyz`
(ADR-0026, ADR-0027) and a public deployment on Coolify/Hetzner with managed state and a live demo.
Starting either needed three registered domains (the product, `patchgrid-files.net` for attachments, an
ops zone for the delegated ACME challenge), a server, a mail provider, and a demo mode so that visitors
could not lock each other out of a shared owner account.

Patchgrid is a learning and portfolio project. What it is meant to teach and show is the architecture:
tenant isolation in the schema and in Postgres, the authorization model, the per-tenant job and event
design, the hardening. None of that needs to be on the internet to be read, run or tested, and all of it
is already exercised end to end on a laptop.

## Decision

**Patchgrid is not deployed publicly.** It runs locally, through Docker Compose and `pnpm dev`, and that
is the supported way to use it.

- **The exit of M10 is the clone-and-run one**: a stranger clones the repository, runs three commands,
  signs up and uses a realistic system, and the README explains the decisions. "The public demo is live"
  is dropped from it.
- **The DNS/TLS and deploy items are dropped, not deferred.** M10 is complete.
- **The deployment design stays, as design.** `DNS.md`, ADR-0026 and ADR-0027 still describe how the
  system would be addressed, certified and mailed in production, and the constraints they put on the
  code (the cookie domain, `RESERVED_SLUGS`, the inbound address, attachments on their own registrable
  domain) stay enforced. They are the reasoning a reader learns from; nothing is removed because it will
  not be exercised.
- **The production images and `docker-compose.prod.yml` stay.** CI keeps building all three images and
  booting the API image to its configuration check, so the production shape cannot rot unnoticed.
- **No demo mode is built.** The seed's shared password is a local convenience, not an exposure, while
  nothing is public.
- **M7 runs its models locally**: Ollama and `phishing-svc` in Compose. Its "ship the models on the live
  demo" item becomes "in the local stack", and ADR-0010's server-or-degraded-mode question does not
  arise.

## Consequences

- No money and no operator. The time goes to implementation and architecture instead.
- Things only a real deployment proves are not proven: a wildcard certificate renewing, SPF/DKIM/DMARC
  alignment at a real receiver, `TRUST_PROXY_HOPS` against a real ingress, a provider's inbound
  signature. `HANDOFF.md` keeps them in one list, "If it is ever deployed", so they are named rather than
  forgotten.
- Two pieces of production plumbing stay unbuilt: SMTP credentials and TLS (Mailpit needs neither) and a
  provider-specific inbound adapter (the signed feed in ADR-0039 is what a provider adapter would
  produce, and `inbound:send` exercises it locally).
- Reversing this needs no code change to the tenancy, auth or mail design: the work is the list in
  `HANDOFF.md`, a demo-mode ADR if the demo is public, and the operations ADR-0026 already describes.
