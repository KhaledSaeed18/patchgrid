# 0026 — Wildcard TLS and DNS operations

- **Status:** Accepted
- **Date:** 2026-09-22
- **Refines:** [0014](0014-subdomain-per-tenant-routing.md), which fixed the hostnames and deferred everything about how they are served

## Context

Subdomain-per-tenant means every customer's address is created by a database insert, not by a DNS change.
The certificate and the DNS zone therefore have to be wildcard, and wildcard certificates cannot be
issued by the HTTP-01 ACME challenge — only DNS-01 can, because proving control of `*.patchgrid.xyz`
means proving control of the zone, not of one web server.

That pulls in a chain of decisions that are genuinely operational rather than incidental, and each has a
sharp edge: the ACME client needs credentials that can write DNS records, those credentials are normally
scoped to the entire zone, and a token that can rewrite `patchgrid.xyz`'s records is a total compromise
of the product — mail, web and certificate issuance at once.

Deployment is M10, but the decisions constrain code written from M1 (cookie domain, host parsing,
`RESERVED_SLUGS`, the inbound mail address), so they are taken now.

## Options considered

**Certificate scope**
1. **Per-tenant certificates issued on signup.** No wildcard needed and each tenant is cryptographically
   distinct; but signup now depends on a third party responding, Let's Encrypt rate-limits apply per
   registered domain, and certificate storage/renewal becomes a stateful service.
2. **One wildcard `*.patchgrid.xyz` plus the apex.** One certificate, renewed every 60 days, no coupling
   between signup and ACME. A single `*.` certificate covers one label only, so `acme.patchgrid.xyz`
   works and `eu.acme.patchgrid.xyz` would not — which is a constraint worth knowing before someone
   designs regional subdomains.

**ACME credential scope**
1. **A full-zone API token** on the registrar. Simplest, and the blast radius is the entire domain.
2. **`_acme-challenge` CNAME delegation.** `_acme-challenge.patchgrid.xyz` is a `CNAME` to a record in a
   separate, otherwise-empty zone (`acme.patchgrid-ops.xyz`). The ACME client holds credentials for
   *that* zone only. A leaked token can issue certificates for `patchgrid.xyz` — which is bad — but
   cannot redirect the website, steal mail, or point the apex anywhere.

**Custom tenant domains** (`support.acme.com`, deferred)
1. `CNAME` to `cname.patchgrid.xyz` with per-domain certificates via HTTP-01 or `tls-alpn-01`.
2. Full delegation (the customer hands over an `NS` record). Powerful, and far too much for v1.

## Decision

- **One wildcard certificate** for `*.patchgrid.xyz` plus a SAN for the apex, issued by Let's Encrypt via
  **DNS-01**, renewed automatically at 30 days remaining and alarmed at 21.
- **`_acme-challenge` is delegated by CNAME to a dedicated ops zone.** The deployment holds an API token
  for that zone and nothing else. This is the single most valuable line in this ADR: it turns "the server
  can rewrite our entire domain" into "the server can request certificates".
- **`CAA` records** on `patchgrid.xyz` restrict issuance to the chosen CA and record an incident contact:
  `patchgrid.xyz. CAA 0 issue "letsencrypt.org"`, `CAA 0 issuewild "letsencrypt.org"`,
  `CAA 0 iodef "mailto:security@patchgrid.xyz"`. Two lines of DNS that make mis-issuance by any other CA
  a policy violation rather than a possibility.
- **Wildcard `A`/`AAAA` for `*.patchgrid.xyz`** pointing at the ingress, with explicit records for the
  apex, `www`, `app`, `api`, `admin`, `files` and `inbound` so those never depend on the wildcard and
  cannot be shadowed by a tenant slug. Every one of those labels is in `RESERVED_SLUGS`
  (`@patchgrid/contracts`) — the DNS zone and the reserved list are two halves of one decision, and the
  rule is that a new hostname adds both in the same PR.
- **TLS 1.2 minimum**, HSTS with `includeSubDomains` and a long max-age **only after** the wildcard is
  proven — `includeSubDomains` on a shared parent domain is effectively irreversible, and turning it on
  early would break any tenant subdomain that ever failed to serve TLS.
- **Certificate transparency is a leak**, and it is accepted: a wildcard certificate publishes
  `*.patchgrid.xyz`, not each tenant's slug, which is precisely why the wildcard is better than
  per-tenant certificates for customer privacy. Per-tenant certificates would publish every customer's
  name to CT logs.
- **Custom tenant domains** are designed for and not shipped: a `Domain { orgId, hostname, verifiedAt,
  certificateStatus }` table consulted by tenant resolution *before* slug parsing, ownership proven by a
  TXT record, certificates issued per domain. Nothing in the resolution order (ADR-0024) forbids it —
  the credential already carries the tenant, so a custom host is one more way to corroborate it.

### The Public Suffix List question, and why the answer is "not yet"

Because tenants control `*.patchgrid.xyz`, the domain arguably belongs on the PSL. Listing it would give
every tenant its own cookie jar and **eliminate cookie tossing entirely** (ADR-0024's residual risk).

It would also make `Domain=.patchgrid.xyz` cookies impossible, so `app.patchgrid.xyz` and
`api.patchgrid.xyz` could no longer share a session — which is the foundation of the current session
design. Adopting the PSL would mean moving to host-only cookies plus a token-exchange handoff between
`app.` and each tenant host, and `api.` would have to accept `Authorization` headers instead of cookies,
which breaks `EventSource`.

That is a real, defensible architecture and a genuinely interesting one; it is not a change to make while
the product is being built, and PSL additions are slow to propagate and effectively permanent. Recorded
here as the known structural fix, to be revisited if the tenant population ever includes parties who
should not be able to inconvenience each other.

## Consequences

- Provisioning a tenant stays a database insert. No DNS call, no ACME call, no failure mode between
  "signed up" and "can reach my workspace".
- Renewal is the operational risk: one certificate serves every customer, so a failed renewal is a total
  outage. Hence the 30-day renewal, 21-day alarm, and a synthetic check that fetches
  `https://renewal-canary.patchgrid.xyz` (a reserved label) and asserts the expiry date.
- Local development needs none of this — `lvh.me` and `*.localhost` are plain HTTP — which is why the
  whole area could be deferred without blocking M0–M9.
- A single-label wildcard means no nested tenant subdomains, ever, without a second certificate. Worth
  knowing before someone proposes `eu.acme.patchgrid.xyz`.
- Full detail — record-by-record zone contents, the renewal runbook, and the custom-domain flow — lives
  in `docs/DNS.md`.
