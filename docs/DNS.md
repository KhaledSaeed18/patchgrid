# Patchgrid — Hostnames, DNS and TLS

Decisions behind this file: ADR-0014 (which hostnames exist), ADR-0024 (how a request names its tenant),
ADR-0026 (wildcard TLS and zone operations), ADR-0027 (mail DNS and inbound authentication).

Deployment is M10. This document is written now because the choices constrain code from M1: the cookie
domain, the host parser, `RESERVED_SLUGS`, and the inbound mail address are all downstream of it.

---

## 1. The zone

`patchgrid.xyz`, one zone, one wildcard certificate. Every label below is also in `RESERVED_SLUGS`
(`@patchgrid/contracts`) — **the zone file and the reserved list are two halves of one decision.** A
label that exists in DNS but not in the reserved list can be claimed by a customer as a slug, and the
customer's tenant would then be shadowed by (or shadow) real infrastructure.

| Name | Type | Purpose |
| --- | --- | --- |
| `patchgrid.xyz` | `A` / `AAAA` | apex → ingress, `apps/www` |
| `www` | `CNAME` | → apex |
| `app` | `A` / `AAAA` | tenant-less entry: login, org picker, create workspace |
| `api` | `A` / `AAAA` | NestJS |
| `admin` | `A` / `AAAA` | platform back-office |
| `files` | `A` / `AAAA` | object-storage gateway for attachments — a **separate origin**, so an uploaded document is never same-site with a session cookie |
| `inbound` | `MX` | inbound mail for ticket intake |
| `*` | `A` / `AAAA` | every tenant, `<slug>.patchgrid.xyz` |
| `renewal-canary` | `CNAME` | → apex; a reserved label the certificate monitor fetches |
| `_acme-challenge` | `CNAME` | → the delegated ops zone (§3) |
| `@`, `_dmarc`, `<sel>._domainkey` | `TXT` | mail authentication (§4) |
| `@` | `CAA` | issuance restriction (§3) |

Explicit records come **before** the wildcard in specificity, so `api.patchgrid.xyz` resolves to the API
regardless of the wildcard. The wildcard is what makes provisioning a tenant a database insert rather
than a DNS change.

**One wildcard covers one label.** `acme.patchgrid.xyz` matches `*.patchgrid.xyz`;
`eu.acme.patchgrid.xyz` does not. Worth knowing before anyone proposes regional or per-environment
tenant subdomains — that would need a second wildcard and a second certificate.

---

## 2. How a request finds its tenant

Worth restating here because the DNS shape suggests an answer that is wrong.

DNS resolves `acme.patchgrid.xyz` to the app. The **app** knows its tenant from the host. The **API**
does not — every API request arrives at `api.patchgrid.xyz`, whose host contains no slug. So the tenant
comes from the credential, with `Origin` (or `X-Patchgrid-Tenant`, for server-side callers that send no
`Origin`) as the cross-check. Full order in `TENANCY.md` §6 and ADR-0024.

The practical consequence for DNS: there is no `acme.api.patchgrid.xyz`, and adding one later would need
a second-level wildcard and a second certificate. The single-label wildcard is a deliberate limit, not an
oversight.

---

## 3. TLS

### Why DNS-01 and not HTTP-01

HTTP-01 proves control of one web server by serving a file. A wildcard certificate asserts authority over
an entire label space, so ACME will not issue one from HTTP-01 — only **DNS-01**, which proves control of
the zone by publishing a TXT record at `_acme-challenge.patchgrid.xyz`.

That is the whole reason the following credential problem exists, and it is the interesting part.

### The credential blast-radius problem, and the fix

An ACME client doing DNS-01 needs an API token that can write records in the zone. Registrar tokens are
normally **zone-wide**. A token that can rewrite `patchgrid.xyz` can repoint the apex, hijack `MX` and
read the company's mail, and pass any future domain-validation challenge. Handing that to a renewal cron
job on an application server is a poor trade for a certificate.

**`_acme-challenge` CNAME delegation** fixes it:

```
_acme-challenge.patchgrid.xyz.  CNAME  patchgrid.acme.patchgrid-ops.xyz.
```

ACME follows the CNAME and validates the TXT record at the target. The deployment holds credentials for
`patchgrid-ops.xyz` — a separate, otherwise-empty zone — and nothing else. A leaked token can now request
certificates for `patchgrid.xyz`, which is bad, but cannot redirect the website, steal mail, or touch the
apex.

This is the single most valuable line in the TLS setup, and it is two DNS records.

### CAA

```
patchgrid.xyz.  CAA  0 issue     "letsencrypt.org"
patchgrid.xyz.  CAA  0 issuewild "letsencrypt.org"
patchgrid.xyz.  CAA  0 iodef     "mailto:security@patchgrid.xyz"
```

`issuewild` is separate from `issue` and is the one that matters here. `iodef` means a CA that receives a
request violating the policy has somewhere to report it. Three lines that turn mis-issuance by any other
CA from possible into a policy violation.

### Renewal

One certificate serves every customer, so a failed renewal is a **total** outage — this is the
operational risk the wildcard buys in exchange for provisioning simplicity.

- Renew at 30 days remaining; alarm at 21; page at 14.
- A synthetic check fetches `https://renewal-canary.patchgrid.xyz` and asserts the presented certificate's
  expiry, so the alarm is on the *served* certificate rather than on a file the renewer claims to have
  written.
- Staging endpoint for anything experimental. Let's Encrypt's production rate limits are per registered
  domain, and burning them on a broken automation locks out real renewals.

### Certificate Transparency — a privacy argument for the wildcard

Every issued certificate is published to public CT logs. **Per-tenant certificates would publish every
customer's name**: `acme.patchgrid.xyz` in a public, permanently-archived, trivially-scraped log, telling
the world who our customers are. A wildcard publishes `*.patchgrid.xyz` and nothing else.

So the wildcard is not only simpler, it is the more private choice — which is worth stating, because the
instinct is that per-tenant certificates are the more rigorous option.

### HSTS

`Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` — but **only after** the
wildcard is proven in production. `includeSubDomains` on a shared parent is effectively irreversible
within the max-age, and preload more so; turning it on early would break any tenant host that ever failed
to serve TLS. Ship with a short max-age, raise it, then add `preload`.

---

## 4. Mail

Full reasoning in ADR-0027; the records and the alignment logic are here.

### Outbound

| Name | Type | Value |
| --- | --- | --- |
| `patchgrid.xyz` | `TXT` | `v=spf1 include:<provider> -all` |
| `<selector>._domainkey.patchgrid.xyz` | `TXT` | provider DKIM public key |
| `_dmarc.patchgrid.xyz` | `TXT` | `v=DMARC1; p=none; rua=mailto:dmarc@patchgrid.xyz; pct=100` |

**Why tenant mail still authenticates.** ADR-0018 sends tenant email with the organization's name as the
`From` **display name** and a Patchgrid address as the envelope sender:

```
MAIL FROM: <bounces@patchgrid.xyz>          ← SPF authenticates this
From: "Acme IT Desk" <notifications@patchgrid.xyz>   ← DMARC aligns against this domain
Reply-To: acme@inbound.patchgrid.xyz
```

SPF checks the envelope sender; DMARC alignment checks the header `From` **domain**. Both are
`patchgrid.xyz`, so one SPF record and one DKIM key serve every tenant and no customer's deliverability
depends on their own DNS. The display name is not an authenticated identifier, so a tenant renaming itself
cannot break alignment — which is exactly why the name goes there and not in the address.

`-all`, not `~all`: a soft fail invites forgery and tells receivers to accept it anyway.

**DMARC policy is progressed on evidence**: `p=none` while reading aggregate reports, then `quarantine`,
then `reject`. Jumping to `reject` on day one is how organisations discover which of their own systems
were sending mail — after those messages have already been discarded.

**DKIM keys rotate annually** with both selectors published during the overlap, because a message in
flight is validated against the key that signed it.

### Inbound

```
inbound.patchgrid.xyz.  MX  10 <provider inbound host>
```

A separate subdomain, so ticket intake and any future corporate mailbox on the apex are independent — and
so that a provider change touches one record.

The address is `<slug>@inbound.patchgrid.xyz`, which is why **`inbound` is in `RESERVED_SLUGS`**. Without
that, a tenant could register the slug `inbound` and own the hostname carrying every other tenant's mail.

The sender-authentication pipeline — verify webhook signature → resolve tenant → require DMARC-aligned
pass → map to an active membership → thread only for participants — is specified step by step in
ADR-0027 §Inbound pipeline. The short version: knowing a ticket number is not authorization to post on it.

---

## 5. Per-tenant custom domains (designed for, not shipped)

`support.acme.com` pointing at a Patchgrid workspace. Out of scope for v1 (`FEATURES.md`), designed for
so that nothing built now forecloses it.

**Shape:**

```
T  Domain { id, orgId, hostname (globally unique), verificationToken,
            verifiedAt?, certificateStatus, createdAt }
```

1. The admin adds `support.acme.com`; we issue a verification token.
2. They publish `_patchgrid-verify.support.acme.com TXT <token>` **and**
   `support.acme.com CNAME cname.patchgrid.xyz`.
3. We verify the TXT record, then obtain a certificate for that single hostname — HTTP-01 or `tls-alpn-01`
   works here, because it is not a wildcard and traffic already reaches us.
4. Tenant resolution consults `Domain` **before** slug parsing; everything downstream is unchanged,
   because the credential already carries the tenant (ADR-0024) and the host is only corroboration.

**The hard parts, named honestly:** certificate storage and renewal become per-customer state; a customer
who removes the CNAME leaves a dangling certificate to reap; `hostname` must be globally unique and
verified, or one customer claims another's domain; and cookies cannot be shared with `.patchgrid.xyz`
across a different registrable domain, so a custom-domain tenant needs host-only cookies and its own
session handoff. That last one is the reason this is a separate ADR and not a small feature.

---

## 6. Subdomain takeover and slug reuse

A DNS problem wearing a product costume.

The wildcard means `*.patchgrid.xyz` always resolves, so there is no classic dangling-CNAME takeover —
but there is a **slug-level** equivalent: if a released slug could be re-registered by someone else, they
would inherit the previous tenant's bookmarks, emailed deep links, and any browser-cached redirect.
Combined with the shared cookie domain (ADR-0024), that is a phishing and cookie-tossing position.

Hence two rules in `TENANCY.md` §2, both of which are really DNS hygiene:

- **A released slug is never reusable.** `OrganizationSlugHistory` rows are kept forever and excluded from
  availability. Storage cost: nil.
- **The old slug 302-redirects for 30 days, never 301.** A 301 is cached permanently by the browser, and
  nothing that permanent should describe a mutable mapping.

---

## 7. The Public Suffix List question

Because tenants control `*.patchgrid.xyz`, the domain arguably belongs on the PSL — that is what the list
is for: telling browsers where one party's control ends and another's begins.

**What it would fix.** Every tenant would get its own cookie jar. Cookie tossing — a malicious tenant
setting cookies for `.patchgrid.xyz` — would become impossible rather than merely survivable, closing the
residual risk recorded in ADR-0024.

**What it would cost.** `Domain=.patchgrid.xyz` cookies would stop working, which is the foundation of the
current session design: `app.patchgrid.xyz` could no longer hand a session to `acme.patchgrid.xyz`, and
`api.patchgrid.xyz` could not read a tenant's cookie at all. The API would need `Authorization` headers,
which breaks `EventSource` (it cannot set headers), and the org picker would need a token-exchange
handoff per tenant.

**Why not now.** It is a coherent and arguably better architecture, but it is a different one, PSL
additions propagate slowly and are effectively permanent, and the trade only pays when tenants are
genuinely mutually distrustful. Recorded as the known structural fix, to be revisited then — not
forgotten, and not pretended to be free.

---

## 8. Local development needs none of this

Plain HTTP, no certificates, no zone. Three tiers, in order of preference (`ENGINEERING.md`
§Local development):

1. **`lvh.me`** — public wildcard DNS to `127.0.0.1`. Prettiest; a third-party dependency that has lapsed
   before. `sslip.io` and `nip.io` are equivalents.
2. **`*.localhost`** — Chrome and Firefox resolve it to loopback natively. Zero external dependency, no
   `/etc/hosts`. Safari does not accept `Domain=.localhost` cookies.
3. **`/etc/hosts` + `patchgrid.test`** — works offline and in Safari. `.test` is reserved by RFC 6761 for
   exactly this purpose, which is why it is used rather than `.local` (which collides with mDNS).

That this whole document can be deferred to M10 without blocking M0–M9 is the point of the local story.
