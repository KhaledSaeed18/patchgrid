# 0005 — Attachments in S3-compatible storage via presigned URLs

- **Status:** Accepted — upload constraints and serving corrected below
- **Date:** 2026-09-22

> **Erratum (2026-09-22).** Step 1 promises a presigned PUT with "content-type and content-length
> conditions". A presigned **PUT** signs headers and cannot express a length *range*; `content-length-range`
> is a presigned **POST** policy condition. The corrected mechanism is to sign an **exact** `Content-Length`
> and `Content-Type` — the client already declares `sizeBytes` — which is a hard bound rather than a range.
> The `HEAD` verification in step 3 is retained and extended to byte sniffing.
>
> The allow-list as written ("images") admits `image/svg+xml`, which is a script-capable document and, with
> the inline preview in Consequences, a stored-XSS path. SVG, HTML and XHTML are excluded; presigned GETs
> carry `Content-Disposition: attachment` except for a small raster allow-list; attachments are served from
> a separate origin. The cleanup job deletes the **object** as well as the row, and the storage quota
> decrements on delete. See `ARCHITECTURE.md` §Security posture.
>
> **Verified (2026-09-22).** Consequences claims CORS is "configured on the bucket … by the MinIO init
> container". It is not: MinIO implements CORS as a **server** setting
> (`MINIO_API_CORS_ALLOW_ORIGIN`), and `mc cors set` against a current build returns "A header you
> provided implies functionality that is not implemented" — for an XML body; a JSON one fails earlier
> with "decoding xml: EOF". The Compose stack sets the server variable and a preflight from
> `http://acme.lvh.me:3001` is echoed back while `http://evil.example.com` is not. Separately,
> `docker.io/minio/minio` is no longer publicly pullable; the image comes from quay.io.

## Context

Tickets and comments need file attachments (screenshots, logs, phishing email exports). The spec listed an `Attachment` table with a `url` and no storage decision.

## Options considered

1. **Local disk on the API container** — simplest; breaks with more than one API instance, needs volume management, and the API streams every byte.
2. **Bytes in Postgres (`bytea`)** — no extra service; bloats the DB and backups, poor for 10 MB files.
3. **S3-compatible object storage, uploads proxied through the API** — durable; the API still streams every byte and enforces limits itself.
4. **S3-compatible object storage with presigned upload/download URLs** — the browser talks to storage directly; the API only issues short-lived, constrained URLs and records metadata. Production-standard, and MinIO gives an identical local setup.

## Decision

Option 4. Flow:

1. `POST /attachments/presign { filename, mimeType, sizeBytes, ticketId | commentId }` → API validates the allow-list and size, creates an `Attachment { status: PENDING, storageKey }`, returns a presigned PUT (5-minute TTL, content-type and content-length conditions).
2. Browser PUTs the file to MinIO/S3.
3. `POST /attachments/:id/complete` → API `HEAD`s the object, checks size and type, marks `READY`, audit-logs.
4. Downloads are presigned GETs (2-minute TTL) issued only after the RBAC check on the owning ticket.

A cleanup job deletes `PENDING` attachments older than one hour. Storage keys are `org/<orgId>/tickets/<ticketId>/<uuid>-<sanitized-filename>`.

## Consequences

- Needs CORS configured on the bucket for the web origin (done by the MinIO init container locally).
- The API never holds file bytes; memory and timeouts stay predictable.
- The `@aws-sdk/client-s3` client works unchanged against MinIO, Hetzner Object Storage, or AWS.
- Inline image preview in comments uses the same presigned GET; no public bucket, ever.
