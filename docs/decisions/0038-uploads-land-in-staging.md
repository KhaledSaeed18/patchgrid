# 0038 — Uploads land in staging, and only checked bytes are served

- **Status:** Accepted
- **Date:** 2026-10-15
- **Refines:** [0005](0005-attachments-s3-presigned.md)

## Context

ADR-0005 has the browser PUT a file straight to object storage with a presigned URL. The API then
checks the bytes at `complete` and marks the attachment `READY`. The M5 review found two ways around
that, both because **a presigned PUT can be used again until it expires**:

1. **Swap after check.** Upload a real PDF and complete it. Then, within the URL's five minutes, PUT
   other bytes of the same length and type to the same URL. Downloads serve the new bytes under the old
   verdict.
2. **Quota for free.** Presign, which consumes the quota. Then delete the pending upload, or send bytes
   that `complete` refuses: either gave the quota back at once. Then PUT to the still-valid URL. The
   object is stored, nothing tracks it, and nothing counts it.

## Decision

- **The PUT writes to `staging/<final key>`**, and only the presigned URL ever writes there. `complete`
  sniffs the staging object, copies it server-side to the final key (`org/<orgId>/…`), and deletes the
  staging copy. Downloads are presigned against the final key only, which no upload URL reaches, so the
  bytes served are the bytes checked.
- **A refused upload loses its bytes, not its row.** It stays `PENDING`, holding its quota, until the
  abandoned-upload sweep (one hour, far past the five-minute URL) removes the row and returns the quota.
- **An unfinished upload cannot be deleted** (`409`); the sweep is its only way out, for the same
  reason.
- **A bucket lifecycle rule expires `staging/` after a day.** A PUT to a used URL after `complete` can
  still land there; the rule bounds it to one object per upload already paid for, for a day. Local
  MinIO sets it in `docker/minio/init.sh`; production storage sets the same rule.

## Consequences

- `complete` costs one server-side copy. The bytes never pass through the API.
- A rejected file's quota comes back within the hour rather than at once.
- Keys under `staging/` start with `staging/`, not `org/<orgId>/`, so the bucket prefix rule can match
  them. The tenant is still the next segment of every key.
