# End-to-end tests

Playwright, against a running stack: the API on `api.lvh.me:4000`, the app on `app.lvh.me:3001` and
every `<slug>.lvh.me:3001`, Mailpit on `localhost:8025`, and the seeded workspaces (`pnpm db:seed`:
Acme and Globex, every account's password `patchgrid-demo`). One worker, in order — the specs share
the stack. Browsers are not installed by `pnpm install`: `pnpm exec playwright install chromium` once.

```
pnpm --filter @patchgrid/app test:e2e
```

| Spec                 | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signup-to-incident` | Signup (the form's one fetch, made as the site makes it) → the emailed link verifies and signs in → a workspace provisioned on its own subdomain → an agent invited, joining with a new account from the emailed link → one incident raised, started, resolved with a note, and closed by its requester                                                                                                                                                                                                                          |
| `sla-breach`         | A requester raises an incident; its response deadline is moved into the past (`support/clock.ts`, the suite's test clock); the real minute sweep marks it overdue, seen from the owner's view                                                                                                                                                                                                                                                                                                                                    |
| `change-approval`    | An agent drafts a Change with its plan and submits it; the requester of a change is never offered its approval; an admin who did not raise it approves; the agent takes it, starts, records the outcome, marks it implemented and closes it                                                                                                                                                                                                                                                                                      |
| `isolation`          | **Cross-tenant:** a session for Acme is sent away from Globex's pages, answers `401` when the same cookies are asked as Globex, and cannot open a workspace it is not a member of. **Role escalation:** an agent gets "Nothing here" on admin pages and `403` promoting anyone, themselves included, inviting an admin or minting a token. **Two tabs, two tenants:** one person in Acme and Globex at once, raising a ticket in each, each tab keeping its own workspace and neither list showing the other's ticket (ADR-0024) |

| `passkeys` | A fresh owner adds a passkey from the account page against the password and is shown recovery codes once; signs back in with nothing typed, straight into the workspace the login was for; mints an API token behind a step-up the passkey proves (no password field offered); and removes the passkey, proved by itself. Chromium's virtual authenticator answers the prompts, and the two development hosts are treated as secure for WebAuthn (ADR-0053) |

| `sso` | Against the Keycloak in `docker compose --profile sso`: `kim@acme.test` signs in through it from the login page and is provisioned into Acme, the picker says the session is Acme's alone and the account page says why it can change nothing account-wide; `nora@acme.test`, unverified at the provider, is turned away with the reason; an owner requires SSO behind a step-up, an agent with only a password is sent to the provider, and the owner's own password still opens Acme (ADR-0054) |

The negatives are the point. The happy paths are the easy part.

Against the production rehearsal on emulated AWS (ADR-0058), `pnpm aws:e2e` runs every spec but `sso`
through the load balancer on `https://*.patchgrid.test`. It sets `E2E_PROTOCOL=https`, empty ports,
`E2E_RESOLVE_TO` (where the root domain and its subdomains resolve, for Chromium and for the suite's
own requests) and `E2E_CA_FILE` (the private CA Chromium trusts by its key hash); see `infra/README.md`.

Every run makes its own rows — a workspace `e2e-<run>` and tickets titled with the run id — so a
re-run never trips over the last one. The SLA spec moves its ticket's deadline instead of waiting for
it, so it waits only for the next minute's sweep — the one write the suite makes to the database, as its
owner, through `DATABASE_MIGRATION_URL`. In CI the suite runs on `main` only (ADR-0011).
