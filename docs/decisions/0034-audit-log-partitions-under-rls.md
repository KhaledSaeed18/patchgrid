# 0034 — Audit-log partitions under RLS

- **Status:** Accepted
- **Date:** 2026-10-09
- **Refines:** `ARCHITECTURE.md` §Data model (partitioned `AuditLog`), [0015](0015-tenant-isolation-rls.md), [0023](0023-identity-keys-and-tenant-safe-foreign-keys.md), [0028](0028-data-protection-export-erasure-retention.md) (retention)

## Context

`ARCHITECTURE.md` says `AuditLog` is partitioned by month, with the policy on the parent, and ADR-0028
makes retention "a `DETACH PARTITION` rather than a delete". Building it in M1 — membership is the first
audited change — exposes four things those sentences do not settle:

1. **A partitioned table's unique constraints must include the partition key.** `@@unique([orgId, id])`,
   required of every tenant-owned table so it can be a composite FK target (ADR-0023), cannot exist.
2. **Policies on the parent apply only to queries through the parent.** A query that names a partition
   directly is checked against _the partition's_ policies — and a partition created without any has RLS
   off. `ARCHITECTURE.md`'s "inherited by every partition" is true only for access through the parent.
3. **Somebody has to create next month's partition**, and the application role has no `CREATE`
   privilege, on purpose (`db:doctor` asserts it).
4. **Partitions are shared by every tenant**, so detaching one deletes a month for everybody. ADR-0028's
   two windows (2 years `FREE`, 7 years `PRO`) cannot both be a detach.

Prisma 7 introspects a partitioned parent as an ordinary model and does not list its partitions, so
neither `migrate dev` nor the drift check sees a difference — verified against a scratch database
before deciding.

## Decision

- **The parent is created by hand-editing the generated migration** to `PARTITION BY RANGE
  ("createdAt")`. Its primary key is `(id, "createdAt")`. It is never a foreign-key target, so it is
  exempt from the composite-target assertion — and so are its partitions. The schema test exempts them
  by catalog fact (`relkind = 'p'`, `relispartition`), not by a name list.
- **Every partition carries the full isolation shape itself**: `ENABLE` and `FORCE ROW LEVEL SECURITY`
  and the one template policy, applied by the function that creates it. The schema assertions therefore
  hold for partitions exactly as for any table, and a direct partition query is as fenced as the parent.
- **Partitions are created by `ensure_audit_log_partition(timestamptz)`**, a `SECURITY DEFINER`
  function owned by `patchgrid_owner` with `search_path` pinned, `EXECUTE` granted to `patchgrid_app`
  and revoked from `PUBLIC`. It can create exactly one thing — the month partition containing the given
  instant, named `AuditLog_YYYY_MM` — and is idempotent. The application role gains no `CREATE`.
- **No `DEFAULT` partition.** A default partition holding rows for a month makes creating that month's
  partition fail later; an insert failing loudly because no partition exists is the better failure,
  and the API makes sure it never happens: it ensures the current and next month at boot, and the
  `audit-partition` job does the same daily.
- **Retention**: detaching is done at the _longest_ window (7 years), by the `audit-partition` job, once
  a partition is entirely past it. A shorter per-plan window is a per-tenant batched `DELETE` inside
  `runAsTenant`, owned by the retention item, not by detach. ADR-0028's sentence describes the outer
  bound only.

## Consequences

- `AuditLog` rows are addressed by `(id, createdAt)` internally; nothing outside the audit module ever
  needs to address one.
- The migration that creates the parent also creates the function and the first partitions, so a fresh
  database is usable before the API has booted.
- `db:doctor`'s "the app role cannot `CREATE`" stays true; the function is the one narrow door, and it
  is visible in the migration rather than granted as a privilege.
- If Prisma ever starts treating partitions as drift, the fix is in the drift script (filter
  `relispartition`), not in the design.
