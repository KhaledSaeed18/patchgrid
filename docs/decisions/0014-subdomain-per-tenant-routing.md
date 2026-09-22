# 0014 — Subdomain-per-tenant routing, three subdomains, three deployables

- **Status:** Accepted — cookie scoping and tenant resolution superseded by [0024](0024-per-tenant-cookies-and-api-tenant-resolution.md)
- **Date:** 2026-09-22

> **Erratum (2026-09-22).** Two claims in the Decision do not hold. (1) "Tenant resolution … parses the
> host" is unimplementable on `api.patchgrid.xyz`, whose host contains no slug; the tenant comes from the
> credential, with `Origin` as a cross-check (ADR-0024). (2) A single cookie on `Domain=.patchgrid.xyz`
> reproduces the very drawback used here to reject the single-host option — two tenants in two tabs
> overwrite each other's session. Cookies are per tenant (ADR-0024). The reserved-subdomain list has also
> moved to `RESERVED_SLUGS` in `@patchgrid/contracts`, which is now its only definition.

## Context

The product has three distinct surfaces — a public marketing site, the authenticated application, and the HTTP API — and each tenant should have its own recognisable address. How tenants are addressed affects DNS, TLS, cookies, CORS, local development, and the request pipeline, so it must be settled before auth is written.

## Options considered

**Tenant addressing**
1. **Single app host, tenant from the session** (`app.patchgrid.xyz`, org in the JWT) — one certificate, trivial local dev; the tenant is invisible in the URL, multiple sessions in one browser fight over one cookie, and it looks less like a real product.
2. **Path-based** (`app.patchgrid.xyz/acme/...`) — no DNS work; every route grows a segment, and it is the least common pattern in comparable products.
3. **Subdomain per tenant** (`acme.patchgrid.xyz`) — how Slack, Zendesk, Freshservice and Jira Service Management all do it. Tenant is visible and bookmarkable, cookies can be scoped per tenant, two tenants can be open in two tabs. Costs: wildcard DNS, wildcard TLS, host parsing in the request pipeline, and a local-development story.

**Surface split**
1. One Next.js app serving marketing and dashboard — one deployable; marketing wants static generation, SEO and a public cache, the dashboard wants auth on every request. Conflicting build and caching profiles.
2. **Separate apps** — `www` (marketing, mostly static) and `app` (authenticated dashboard), plus the NestJS `api`.

## Decision

Subdomain per tenant, three deployables:

| Host | App | Nature |
| --- | --- | --- |
| `patchgrid.xyz`, `www.patchgrid.xyz` | `apps/www` | Public marketing: landing, pricing, docs, blog, signup entry. Static/ISR, SEO-optimised, no tenant context |
| `<slug>.patchgrid.xyz` | `apps/app` | Authenticated dashboard for one tenant. Tenant resolved from the host |
| `api.patchgrid.xyz` | `apps/api` | NestJS. Tenant resolved from the `Origin`/`Referer` host **and** cross-checked against the token |
| `app.patchgrid.xyz` | `apps/app` | Tenant-less entry: login, org picker, accept-invite, create-org; redirects into `<slug>.` once an org is chosen |
| `admin.patchgrid.xyz` | (later) | Reserved for the platform back-office |

Rules:

- **Slug format**: 3–30 characters, `[a-z0-9]` with single internal hyphens, no leading/trailing hyphen, no `--` (avoids punycode `xn--` confusion), not in the reserved list, unique. Validated by a Zod schema in `@patchgrid/contracts` so the marketing signup form and the API agree.
- **Reserved subdomains**: `www api app admin docs help support status blog mail smtp imap cdn static assets media img files staging stage dev test demo sandbox billing account accounts auth login signup register portal internal ops metrics grafana health about legal privacy terms security` — plus anything already taken.
- **Tenant resolution** is a Nest middleware that parses the host, looks the org up (cached in Redis for 60 s), rejects unknown/suspended slugs with 404, and puts the tenant into an `AsyncLocalStorage` context (ADR-0015).
- **Token/host binding**: the access token carries `orgId`. If the request's resolved tenant differs from the token's `orgId`, the API responds `403` — one tenant's subdomain can never act on another's data even with a valid session.
- **Cookies** are issued for `Domain=.patchgrid.xyz` so `app.`, `<slug>.` and `api.` share the session, with the host/token binding above as the guard. The refresh cookie is additionally path-scoped to `/api/v1/auth`.
- **CORS** allows the apex, `www`, `app` and any valid `<slug>.patchgrid.xyz`, validated against the slug regex rather than a static list, with credentials enabled.
- **CSRF**: subdomains are same-site, so `SameSite=Lax` does *not* separate them. The API therefore also requires an `X-Requested-With: patchgrid` header on every mutating request and validates `Origin` against the resolved tenant host.

**Local development** uses `lvh.me`, a public domain whose wildcard DNS resolves to `127.0.0.1`: `acme.lvh.me:3001`, `api.lvh.me:4000`, `www` at `lvh.me:3000`. Cookies on `Domain=.lvh.me` behave exactly like production, and no `/etc/hosts` edits are needed. Offline fallback: `/etc/hosts` entries for the seeded slugs under `patchgrid.test`, documented in `ENGINEERING.md`.

## Consequences

- Production needs a wildcard DNS record `*.patchgrid.xyz` and a wildcard TLS certificate (DNS-01 ACME challenge). That is a deployment concern for the final milestone, but the code assumes it from day one.
- `apps/app` runs one deployment serving all tenants; the tenant is a request-time value, never a build-time one, so nothing tenant-specific may be statically generated in `apps/app`.
- Three Dockerfiles, three CI build targets, three Coolify applications later.
- Custom domains per tenant (`support.acme.com`) are a natural extension: add a `Domain` table mapping hostnames to orgs, and make tenant resolution consult it before falling back to slug parsing. Deliberately not in v1.
- The marketing site is the only surface that may be publicly cached; it must never render tenant data.
