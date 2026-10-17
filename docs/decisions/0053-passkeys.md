# 0053 — Passkeys: a credential that signs in alone, scoped to the workspace hosts

- **Status:** Accepted
- **Date:** 2026-10-17
- **Refines:** [0029](0029-mfa-and-step-up-authentication.md), [0045](0045-member-mfa-as-built.md); builds on
  [0024](0024-per-tenant-cookies-and-api-tenant-resolution.md), [0040](0040-platform-credential-and-the-admin-host.md)

## Context

ADR-0029 chose TOTP and named WebAuthn as "the genuinely correct answer" it was deferring: phishing
resistant where a relayed code is not, and a larger build — several authenticators per person, synced
credentials, a harder recovery story. ADR-0045 built TOTP for members and promised to add nothing that
would obstruct passkeys. M13 builds them.

Three things about Patchgrid shape the design more than WebAuthn itself does. Every workspace is its
own host (`<slug>.<root>`, ADR-0014) and the API is a fourth (`api.<root>`, ADR-0024), so a credential
made on one host has to be usable on all of them. The back-office lives on `admin.<root>` under its own
credential (ADR-0040), and that host is under the same registrable domain. And development runs on
plain-http `lvh.me`, which no browser treats as a secure context.

## Decision

### One relying party, the root domain; the origin decides where it counts

The relying-party ID is `ROOT_DOMAIN`. A passkey made on `app.<root>` works on every workspace host,
which is what a person in three workspaces expects — one passkey, not three.

Because `admin.<root>` and `www.<root>` sit under the same root, the browser would happily produce an
assertion there too, so the server partitions by origin. The `origin` signed into the client data
must pass `classifyOrigin` (the policy CORS and tenant resolution already share) as a `tenant` host or
the `app` host. `admin`, `www` and the apex are refused before the signature is checked. The scheme and
port come from the same policy, so http with a development port is accepted locally and only https in
production. One parser decides both who may call the API and where a passkey counts.

### The back-office never takes one

Operators keep the password and TOTP that ADR-0040 made mandatory. The platform's verify schema gains
no assertion field, the admin host offers no ceremony, and the origin rule above refuses one even if
someone builds the request by hand. An operator credential that a synced keychain can carry to any
device is a separate decision with its own enrolment story, and nothing here makes it easier to take
by accident.

### A table of its own, not another row kind

ADR-0029 sketched WebAuthn as `kind: WEBAUTHN` on `UserMfaFactor`. Built, that does not fit: the table
allows one confirmed factor per kind, a person should hold several passkeys (a laptop, a phone, a
hardware key), and the payloads share nothing — an encrypted TOTP secret beside a public key, a
credential id, a counter and transports.

```
P  UserPasskey { id, userId, credentialId bytea UNIQUE, publicKey bytea, signCount, transports[],
                 aaguid, backedUp, label, createdAt, lastUsedAt? }
```

It is platform-class, like the factor tables: it belongs to a person, not to a workspace, has no
`orgId`, and goes in the schema-coverage test's platform list. The public key is not a secret and is
stored as it is; a database dump yields nothing that signs. Rows cascade with the user, so erasure
(ADR-0044) removes them.

**"Has a factor" now means a confirmed TOTP factor or at least one passkey.** Every place that asked
`mfa.confirmed(userId)` asks that instead: the login challenge, `requireMfa`, step-up, and the identity
summary.

### What the ceremonies ask for

User verification is **required** on every ceremony: the device's PIN or biometric is the second
factor, which is what lets a passkey stand alone. Registration asks for a discoverable credential, so
sign-in needs no email first, and for attestation `none`. Patchgrid keeps no allow-list of
authenticator makes, so proof of make would be checked against nothing. `excludeCredentials` lists the
person's existing passkeys, so the same device is not registered twice.

Each ceremony's challenge lives in Redis for five minutes under a random id the options response
returns, and is spent with `GETDEL`: a challenge verifies at most once, and a challenge issued for one
purpose (`register`, `login`, `proof`) is refused for another. With Redis down, ceremonies answer `503`,
as the lockout and the login challenge already do.

The signature counter is checked the standard way: if both the stored and the presented counts are
above zero and the presented one has not increased, the assertion is refused and the person is told by
mail. A cloned authenticator is the only innocent-looking explanation. Synced passkeys report zero and
are not counted.

### Signing in without a password

`POST /auth/passkeys/login/options` is public and returns options with no `allowCredentials`. `POST
/auth/passkeys/login` takes the assertion and, like the password login, an optional workspace slug. The
credential is looked up by id and the `userHandle` must match its owner. A verified, not-erased account
then gets what a completed second step gets today: `pg_id` and, if a slug was named and the membership
allows it, that workspace's pair. There is no `mfa-required` stage after it. A user-verified passkey is
both factors, so it satisfies `requireMfa` on its own.

An unknown credential, a wrong signature, a refused origin and a spent challenge all answer the same
`401`. None of them counts against a person's lockout: an unknown credential names no one, and a
known credential with a bad signature is not someone guessing a code. The route is throttled per
address like the rest of `/auth`.

### The second step and step-up accept it

When the password is right and the person has a factor, `mfa-required` now says which kinds:
`{ status: "mfa-required", methods: ["totp", "passkey"] }`, whichever they hold. The challenge only
ever reaches someone who typed the right password, so naming the kinds tells an attacker nothing the
password did not. `POST /auth/mfa` accepts a passkey assertion beside a code and a recovery code, and
so does `POST /auth/step-up`, with the same five-minute `sua` claim at the end. ADR-0045's rule stands
with "the factor" widened: any factor the person holds is a proof, and the password is a proof only
when they hold none.

### Registering takes a fresh proof

A passkey signs in alone, so a stolen `pg_id` that could add one would own the account, which is worse
than the TOTP enrolment hole the M9 review closed (ADR-0045, erratum). Registration options therefore
take a proof in the request, by the step-up rule: a factor if the person has one, otherwise the
password, counted against the same lockout. The attestation that follows must answer that challenge
within its five minutes.

### Recovery codes belong to the person, not to a factor

Today the codes arrive when TOTP is confirmed and leave when it is turned off. With two kinds they are
issued when the person's **first** factor of any kind is set up and removed only when the **last** one
goes. Turning off TOTP while a passkey remains keeps them. Losing every device is what the codes are
for, and a passkey-only person needs them as much as a TOTP-only one. Using one ends every other
session, as before.

### List, rename, remove

`GET /auth/passkeys` lists the person's passkeys: label, created, last used, whether synced. Renaming is
a plain `PATCH` on `pg_id`, since a label guards nothing. Removing one takes a factor proof, by the same
rule as turning TOTP off, and a passkey may prove its own removal. Every registration and removal is
mailed with the same closing line as the TOTP changes. Removing the last factor in a workspace that
requires one gates the next sign-in, not the current one: ADR-0029's line between a policy and an
outage.

### Local development is not a secure context

WebAuthn exists only in secure contexts, and `http://acme.lvh.me:3001` is not one. The end-to-end
suite starts Chromium with `--unsafely-treat-insecure-origin-as-secure` for the development hosts and
drives a CDP virtual authenticator, so CI runs every ceremony for real. Day-to-day use in a browser
waits for M14's local HTTPS. The settings page says so when `PublicKeyCredential` is absent rather
than showing a button that cannot work.

## Consequences

- A member can sign in with nothing typed, and that sign-in cannot be relayed by a phishing page: the
  origin is signed into every assertion and checked against the workspace hosts.
- Someone holding only a password, or only a `pg_id`, can neither add a passkey nor remove one.
- A person may hold TOTP, passkeys or both; every gate that asked "is there a factor?" counts either,
  and the recovery codes outlive any single kind.
- The back-office stays on password and TOTP, enforced by the origin check as well as by the absence of
  a route.
- `UserMfaFactor` keeps its one-confirmed-per-kind index and its one kind; ADR-0029's sketch of a second
  row kind is replaced by this table.
- Out of scope: attestation and authenticator allow-lists, passkey-only accounts with no password,
  conditional-UI autofill, and passkeys for operators.
