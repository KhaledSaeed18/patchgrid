# 0027 — Email DNS and inbound sender authentication

- **Status:** Accepted
- **Date:** 2026-09-22
- **Refines:** [0018](0018-tenant-aware-jobs-and-events.md), which specified tenant-scoped mail rendering but not its authentication

## Context

Two mail problems, and the second is a security hole rather than a deliverability one.

**Outbound.** ADR-0018 specified that the `From` display name carries the tenant's organization name
while the envelope sender stays a Patchgrid address. That split is correct, and the reason is worth
writing down: SPF authenticates the *envelope* sender (`MAIL FROM`), DMARC alignment is checked against
the *header* `From` domain. Keeping both on `patchgrid.xyz` while varying only the display name means one
SPF record and one DKIM key serve every tenant, and no customer's deliverability depends on their own DNS.

**Inbound.** `FEATURES.md` M6 specified tenant resolution from the recipient address, threading by
`In-Reply-To` and `[INC-000042]`, and bounce detection — but said nothing about authenticating the
**sender**. `From:` is trivially forged. As specified, anyone who learns a tenant's inbound address could:

- create tickets attributed to that tenant's CEO, in a product whose audit trail is a selling point; and,
  worse,
- post a **public comment on an existing incident** as someone else, by putting `[INC-000042]` in a
  subject line — a content-injection path into another company's incident thread.

## Options considered

1. **Trust `From:`.** What the spec implicitly said. Indefensible.
2. **Verify SPF/DKIM/DMARC ourselves** from the raw message. Correct, and a meaningful amount of crypto
   and DNS work to get right.
3. **Consume the receiving provider's verdict.** Resend, Postmark and SES all supply per-message SPF,
   DKIM and DMARC results on the inbound webhook, signed. The provider has already done the work, and the
   webhook signature is what we verify.
4. **Allow only addresses that map to a known member**, regardless of authentication. Necessary but not
   sufficient — a known member's address is exactly what an attacker would forge.

## Decision

Options 3 **and** 4, together. Neither alone is enough: authentication proves the message came from the
domain it claims; membership mapping proves the claimed person belongs here.

### Outbound DNS

| Record | Value | Why |
| --- | --- | --- |
| `patchgrid.xyz TXT` | `v=spf1 include:<provider> -all` | `-all`, not `~all`: a hard fail is the point |
| `<selector>._domainkey.patchgrid.xyz TXT` | provider DKIM key | Rotated annually, with both selectors live during rotation |
| `_dmarc.patchgrid.xyz TXT` | `v=DMARC1; p=none; rua=mailto:dmarc@patchgrid.xyz; pct=100` → `p=quarantine` → `p=reject` | Progressed on evidence from aggregate reports, never jumped to `reject` |
| `inbound.patchgrid.xyz MX` | provider inbound host | A separate subdomain, so inbound routing and the corporate mailbox are independent |

`Reply-To` on tenant mail is `<slug>@inbound.patchgrid.xyz`. The organization name appears only as the
`From` display name — it never touches an authenticated identifier, so a tenant renaming itself cannot
affect alignment.

### Inbound pipeline, in order

1. **Verify the webhook signature.** An unsigned or mis-signed payload is dropped before parsing.
2. **Resolve the tenant from the recipient address.** Unresolvable → drop with a log line, never guess
   (ADR-0018). Suspended or pending-deletion org → drop.
3. **Require a DMARC-aligned `PASS`** from the provider verdict. `FAIL` or `NONE` → store the
   `InboundEmail` with `authVerdict` and no ticket, and do not reply — replying to a forged sender makes
   the system a backscatter source.
4. **Map the sender to an active `Membership`** in that org. Unknown sender → dropped **by default**. An
   org may opt in to `allowExternalRequesters`, which creates the ticket with a visibly badged external
   requester and no membership — useful for a desk that takes mail from contractors, and off until asked
   for.
5. **Threading requires both** a ticket reference *and* that the verified sender is a participant on that
   ticket (requester, assignee, watcher, or any agent who can read it). Otherwise the mail opens a **new**
   ticket with a `RELATES_TO` link to the referenced one. This is the rule that closes the
   comment-injection path: knowing a ticket number is not authorization to post on it.
6. **Bounce and auto-reply detection** (`Auto-Submitted`, `Precedence: bulk`, `List-*`) before any
   notification is generated; loop protection by message-id and by a per-tenant rate limit.
7. **Attachments** are ingested server-side to object storage under the same key scheme, allow-list, size
   cap, byte-sniffing and quota accounting as browser uploads (ADR-0005) — the presign flow is
   browser-only and does not apply here.

`InboundEmail` records `authVerdict` and `senderMembershipId` so every email-sourced ticket can be traced
back to why it was trusted.

## Consequences

- Legitimate mail from a domain with broken DMARC is dropped. That is the correct default for a system
  that attributes tickets to named people, and the failure is visible: the `InboundEmail` row exists with
  its verdict, and admins can see what was rejected and why.
- The product depends on the inbound provider's verdict being honest. Acceptable — we already depend on
  it to deliver the message at all — and the parsing code stays small.
- `p=reject` is reached deliberately, after reading aggregate reports, not on day one. Jumping straight
  to `reject` is how organisations discover which of their own systems were sending mail.
- Per-tenant sending domains (`support@acme.com` as the real `From`) would require each customer to
  publish DNS and would make every tenant's deliverability their own problem. Deferred with custom
  domains (ADR-0026); the display-name split means nothing has to change structurally when it lands.
