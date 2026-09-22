# 0012 — RFC 9457 Problem Details and cursor pagination

- **Status:** Accepted
- **Date:** 2026-09-22

> **Erratum (2026-09-22).** The example `type` URI uses `patchgrid.dev`; the domain is `patchgrid.xyz`
> throughout. Problem `type` URIs are `https://patchgrid.xyz/problems/<slug>` and **resolve** — `apps/www`
> serves one page per type. Full-text search is a documented exception to cursor pagination
> (`DOMAIN.md` §9.1): `ts_rank` is not a stable keyset sort, so search returns a ranked, capped set.

## Context

Every endpoint needs a consistent error shape the web client can map to UI (field errors on forms, toasts, redirects on 401) and a consistent list shape for queues that may grow to tens of thousands of tickets.

## Options considered

**Errors**
1. Nest's default `{ statusCode, message, error }` — inconsistent between validation and other errors, no field-level detail.
2. **RFC 9457 Problem Details** — standard, self-describing (`type`, `title`, `status`, `detail`, `instance`), extensible with `errors[]` for validation. `application/problem+json` content type.

**Pagination**
1. Offset/limit — simple, supports "page 7 of 40"; unstable under inserts (rows shift), slow at deep offsets.
2. **Cursor (keyset)** — stable under concurrent inserts, O(1) at any depth; no direct page jumps, which queue views do not need.

## Decision

Problem Details everywhere via one global exception filter; `errors` is an array of `{ path, message, code }` for Zod failures. `type` is a URL-ish identifier (`https://patchgrid.dev/problems/invalid-transition`) that the web client switches on. Lists return `{ items, nextCursor }` where the cursor is an opaque base64 of `(sortValue, id)`; default limit 25, max 100. Filters and sort are flat query params validated by a per-endpoint contract schema.

## Consequences

- The web `ApiError` class exposes `problem.type` and `problem.errors`, so forms map field errors generically.
- Every 5xx carries a `correlationId` (= request id) that appears in the logs; the UI shows it in the error toast so a bug report is one copy-paste.
- Reports that genuinely need totals (admin dashboards, later) get a separate `count` endpoint rather than a `total` on every page.
