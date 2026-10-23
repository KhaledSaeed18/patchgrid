# 0039 — Inbound mail arrives as signed raw MIME; the verdict is the receiver's Authentication-Results

- **Status:** Accepted
- **Date:** 2026-10-15
- **Refines:** [0027](0027-email-dns-and-inbound-sender-authentication.md), which requires a signed provider
  verdict but names no provider and no format

> **Erratum (2026-10-23).** External requesters are no longer deferred: ADR-0055 builds them as
> memberships of kind `EXTERNAL`, so the NOT NULL requester, the scope branch and the fan-out hold
> unchanged. Mail from an address that maps to no member is dropped unless the workspace opts in.

## Context

ADR-0027 fixes the inbound pipeline: verify the webhook, resolve the tenant from the recipient, require
a DMARC-aligned pass, map the sender to a member, thread only for participants. It leaves three things
open:

- what the webhook looks like;
- where the SPF/DKIM/DMARC verdict is read from;
- how an authenticated sender acts.

Every receiving provider has its own JSON shape and its own signing scheme. Some sign, and some use basic
auth and an IP allow-list.

## Options considered

1. **One provider's format** (Postmark, SES via SNS, Mailgun). Real from day one, but the parsing,
   signature and verdict code is shaped by one vendor. Postmark does not sign inbound webhooks. SNS
   signatures mean fetching and pinning X.509 certificates. Each makes the local harness heavier.
2. **A provider-neutral feed.** Raw RFC 5322 bytes in a body signed with the
   [Standard Webhooks](https://www.standardwebhooks.com/) scheme. The verdict comes from the receiving
   MTA's own `Authentication-Results` header (RFC 8601), which every serious receiver adds. A real
   provider is a thin adapter in front, and the API parses mail one way.

## Decision

Option 2.

- **`POST /api/v1/inbound/email`** is `@Public`. Its credential is the signature:
  - `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA256>` over
    `id.timestamp.body`, keyed with `INBOUND_WEBHOOK_SECRET` (`whsec_…`);
  - five minutes of clock tolerance, and a constant-time comparison;
  - anything unsigned, mis-signed or stale is a `401`, before the body is parsed.
- **The body is** `{ "type": "email.received", "data": { "recipients": [...], "raw": "<base64 MIME>" } }`.
  `recipients` is the envelope (`RCPT TO`), which routing actually used, never the `To:` header. The raw
  message is capped at 25 MB.
- **The tenant is the envelope recipient** `<slug>@inbound.<ROOT_DOMAIN>`, resolved like a request:
  - the exact slug;
  - then a retired slug still inside its 30-day redirect window (TENANCY.md §2);
  - anything else is dropped with a log line, and so is a suspended org;
  - one recipient per org: a message addressed to two tenants is two messages, one each.

  The answer is `202` in every one of those cases, so the endpoint does not say which slugs exist.
- **The raw message is stored before anything is decided** (`org/<orgId>/inbound/<id>.eml`), and the
  rest runs as a per-tenant job (`inbound-email`, ADR-0018). That job writes the `InboundEmail` row with
  its verdict and outcome. A message is processed once per org, keyed by its `Message-ID`.
- **The verdict is the trusted `Authentication-Results`.** That is the topmost header whose authserv-id
  is `INBOUND_AUTHSERV_ID`. Any other is the sender's own claim and is ignored (RFC 8601 §5).
  - `PASS` needs `dmarc=pass` with a `header.from` domain equal to the `From:` domain.
  - `FAIL` is any other DMARC result.
  - `NONE` is no trusted header, or no DMARC result in it.
- **An authenticated sender acts as themselves.** The intake builds a `MemberActor` from the active
  membership the address maps to — the same facts `AuthGuard` builds from an access token. It calls the
  ticket and comment services' explicit-actor entry points, so every permission check runs unchanged.
  The verified address is the credential; nothing writes the request context, and there is no general
  "act as" helper.
- **The ticket's `source` is `EMAIL`.** Mail never writes an internal note: an agent's emailed reply is
  public, as a reply is.
- **External requesters are deferred.** ADR-0027's `allowExternalRequesters` needs a requester who is not
  a membership. That reaches the requester scope branch, notifications and the ticket's NOT NULL
  requester. Until it lands, mail from an address that maps to no active member is always dropped, and
  recorded as such.

## Consequences

- An adapter is needed per production provider: verify the vendor's own signature, then re-sign or
  forward in this shape. The receiving MTA must add `Authentication-Results` with a stable authserv-id.
  SES, Postmark, Mailgun and Google all do.
- The dev harness (`pnpm --filter @patchgrid/api run inbound:send`) builds a message with that header,
  signs it, and posts it. No provider account is needed to develop or test.
- Rejected mail is still visible. Every message that resolves to a tenant leaves an `InboundEmail` row
  with its verdict and outcome, and admins read them in the workspace's inbound log.
