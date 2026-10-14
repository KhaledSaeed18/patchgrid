# 0037 — Attachments are served from their own registrable domain

- **Status:** Accepted
- **Date:** 2026-10-14
- **Resolves:** THREAT-MODEL **TM-1**; corrects [0005](0005-attachments-s3-presigned.md) (erratum), `DNS.md` §1,
  `ARCHITECTURE.md` §Security posture

## Context

ADR-0005 serves attachments through presigned GETs from object storage, and `DNS.md` put that storage
at `files.patchgrid.xyz`. The aim was "a separate origin, so an uploaded document is never same-site
with a session cookie". That aim fails, because same-site is decided by the **registrable domain**:

- `files.patchgrid.xyz` is same-site with every `<slug>.patchgrid.xyz`.
- It receives the `Domain=.patchgrid.xyz` cookies.
- Anything active it served could toss a session cookie (R-1).

Uploaded files are exactly the content this product's users are suspicious of. The allow-list, byte
sniffing and `Content-Disposition: attachment` all reduce the risk; none removes the shared site.

## Options considered

1. **Keep `files.patchgrid.xyz`** and rely on headers. Every defence then lives in a header that a
   misconfigured proxy, a CDN default or a future inline-preview feature can drop. One mistake becomes a
   cookie-tossing primitive against every tenant.
2. **Proxy downloads through the API** with `Content-Disposition: attachment`. The API then streams every
   byte, which ADR-0005 rejected. The response would also come from `api.patchgrid.xyz`, which is the
   same site again.
3. **Serve object storage from a separate registrable domain**: the `githubusercontent.com` pattern.
   Nothing on that domain is ever same-site with a session. Cookies scoped to `.patchgrid.xyz` never
   reach it, and whatever it serves cannot set one there.

## Decision

Option 3.

- **The attachments domain is `patchgrid-files.net`.** The name is a placeholder until registered; what
  matters is that it is not under `patchgrid.xyz`. Object storage, or a CDN in front of it, answers there
  and nowhere else. Presigned URLs, for upload and download alike, are minted against that origin
  (`FILES_PUBLIC_ORIGIN`). Locally it is MinIO at `http://localhost:9000`: `localhost` and `lvh.me` are
  different sites, so the property holds in development too.
- **The API refuses to boot with a files origin that shares the app's root domain**, in every
  environment. It is the same kind of assertion as "the app role cannot bypass RLS": a misconfiguration
  that silently removes a security property is a startup failure, not a warning.
- **Downloads:**
  - Every presigned GET carries `response-content-disposition=attachment` with an RFC 6266 filename.
  - It also carries `response-content-type` set to the type that byte sniffing confirmed, never the type
    the client declared.
  - The one exception is a small raster allow-list (`image/png`, `image/jpeg`, `image/gif`, `image/webp`)
    served `inline` for previews.
  - The TTL stays at 2 minutes.
- **In production the edge in front of storage adds `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox`.** A presigned URL cannot set arbitrary response headers. These two
  are defence in depth on a domain that already carries no session.
- **`files` stays in `RESERVED_SLUGS`**, so no tenant can claim a subdomain that once meant attachments.
  The `files` DNS record under `patchgrid.xyz` is removed.

## Consequences

- One more domain to register, certificate and monitor. The wildcard certificate (ADR-0026) does not
  cover it; it needs its own.
- The browser talks to a third origin. CORS on object storage allows the tenant origins for uploads, as
  it already does.
- An inline image preview is safe to build. The worst a hostile image can do is render on a domain that
  knows nothing about anyone.
- If attachments ever need authentication beyond a presigned URL, such as long-lived share links, that
  is a new ADR. It must not be done by giving the files domain a cookie.
