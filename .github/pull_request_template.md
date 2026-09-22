## What and why

<!-- What changes, and what problem it solves. Link the milestone task in
     docs/FEATURES.md, and the ADR if this is a decision rather than an implementation. -->

## Checklist

<!-- Delete the lines that do not apply. Leaving an unticked box is fine and
     informative; silently dropping it is not. -->

- [ ] Every service method with branching logic has a unit test **in this PR**
- [ ] Any rule changed in `docs/` ships in this PR, not a follow-up
- [ ] A genuine decision has an ADR; a factual error in an accepted ADR has a dated **Erratum**

### If this touches tenant-owned data

- [ ] `orgId` column, RLS policy, and `@@unique([orgId, id])`
- [ ] Composite foreign keys — `references: [orgId, id]` — to every tenant-owned parent
- [ ] `orgId`-first indexes for the queries this adds
- [ ] Entry in the schema-coverage test
- [ ] Every repository method takes an explicit `orgId` and filters on it

### If this touches authorization

- [ ] New permissions are in the catalog/matrix table in `docs/RBAC.md` §6
- [ ] Matrix test rows added, including the negative cases
- [ ] Every new route asserts a permission, or is explicitly `@Public` / `@TenantOptional`

## How it was verified

<!-- What you actually ran, and what it printed. "Tests pass" is not verification;
     "readiness returned 503 naming redis while liveness stayed 200" is. -->
