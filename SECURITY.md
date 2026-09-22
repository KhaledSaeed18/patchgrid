# Security

Patchgrid is a multi-tenant system: one deployment holds many unrelated companies'
operational data, including their security incidents. The isolation model is the
product, not a feature of it.

## Reporting a vulnerability

Report privately, not as a public issue: open a
[security advisory](https://github.com/KhaledSaeed18/patchgrid/security/advisories/new)
or email `security@patchgrid.xyz`. Please include what you did, what happened, and
what you expected. You will get an acknowledgement within a few days.

This is a personal portfolio project, not a commercial service — there is no bounty
and no SLA on a fix. Findings are still genuinely welcome, and credited unless you
would rather not be.

## What we consider most serious

In descending order, because not all bugs in this system are equal:

1. **Cross-tenant data access** — any path by which one organization can read or
   write another's rows. This is the failure mode the whole architecture exists to
   prevent (`docs/TENANCY.md`).
2. **Privilege escalation within a tenant** — a `REQUESTER` reading internal notes,
   an `AGENT` changing roles, an API token exceeding `scope ∩ role`.
3. **Authentication bypass**, session fixation, or a token that survives revocation.
4. **Platform-operator overreach** — any route through which a platform admin reads
   tenant content outside an owner-granted, audited support session (ADR-0020).
5. Everything else: XSS, CSRF, SSRF, injection, denial of service.

## Design decisions that are intentional, not bugs

Reported often enough to be worth stating:

- **Ids are not secrets.** They are UUID v7 and therefore time-ordered and partly
  predictable. Nothing authorizes on unguessability (ADR-0023).
- **Reads of records you may not see return `404`, not `403`.** That is deliberate:
  a `403` would confirm the record exists (`docs/RBAC.md` §11).
- **Tenant existence is discoverable.** `https://acme.patchgrid.xyz` resolving tells
  you `acme` is a customer. Every subdomain-addressed SaaS has this property; it is
  accepted and recorded in the threat model.
- **Any tenant subdomain can set cookies on the shared parent domain** ("cookie
  tossing"). Tokens are signed, so the ceiling is logging a user out rather than
  impersonating them. The structural fix — the Public Suffix List — is analysed in
  `docs/DNS.md` §7.

## Supported versions

`main` only. There are no releases yet.
