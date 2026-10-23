# 0059 — Database roles a managed Postgres can create: the owner is exempt by ownership, not by `BYPASSRLS`

- **Status:** Accepted
- **Date:** 2026-10-24
- **Amends:** [0015](0015-tenant-isolation-rls.md) (`FORCE ROW LEVEL SECURITY`, and the erratum that gave the owner `BYPASSRLS`), [0022](0022-platform-scope-access-under-rls.md) (the boot assertion)

## Context

ADR-0015 put `ENABLE` and `FORCE ROW LEVEL SECURITY` on every tenant-owned table. Its erratum then gave
the migration owner `BYPASSRLS`: the owner runs data migrations and the test harness's cross-tenant
cleanup, and `FORCE` would otherwise subject it to the policies. The bootstrap that sets this up runs as
a Postgres superuser.

A managed Postgres gives you neither of those. On RDS the master user is a member of `rds_superuser`,
which has `CREATEROLE` and `CREATEDB` but is not a superuser. Only the provider's own `rdsadmin` holds
`BYPASSRLS`. Since PostgreSQL 16, `CREATEROLE` cannot hand out an attribute the granting role does not
hold. So the owner of ADR-0015's erratum cannot be created on RDS, and `HANDOFF.md` lists "Postgres that
allows a `BYPASSRLS` migration role" as a deployment blocker. Floci's RDS hides this, because its master
user is a superuser (ADR-0058).

`FORCE` plus an owner with `BYPASSRLS` is one way to say "policies bind everyone but the owner". There is
an older and smaller way: leave `FORCE` off. Postgres already exempts a table's owner from its policies,
and binds every other role.

## Options considered

1. **Keep `FORCE`, and drop `BYPASSRLS` from the owner.** Every migration that touches tenant rows, and
   every cross-tenant line of the test harness, would have to set a tenant per org. Backfills become
   loops over organizations, and the owner can no longer see what it owns.
2. **Keep `FORCE`, and exempt the owner inside every policy** (`… OR current_user = 'patchgrid_owner'`).
   It works on RDS, but it changes the one policy template every table shares to name a role. That is
   exactly the kind of variant the schema test exists to refuse.
3. **Drop `FORCE`. The owner is exempt by ownership, and nobody else is.** The same effective rule as
   today, expressed in the form a managed database can host. One new risk appears: ownership is shared
   by everyone with the owner's privileges, through membership, which `BYPASSRLS` never was (role
   attributes are not inherited). So "the app role is no member of the owner" becomes an invariant, and
   it is asserted.

## Decision

**Option 3.**

- **Tenant tables have `ENABLE ROW LEVEL SECURITY` and the template policy, and no `FORCE`.** A
  migration removes `FORCE` from every table that has it, in `public` and in `audit_archive`. The
  partition creator stops adding it, and the policy generator stops emitting it.
- **The owner holds no `BYPASSRLS`, and no role does.** The owner owns the schema and every table in it,
  so ownership is what exempts it. That keeps migrations and the test harness exactly as they are.
- **The app role must have no privileges of the owner.** The API asserts at boot, before it serves:
  - its role is no superuser
  - it holds no `BYPASSRLS`
  - it is no member of the role that owns the tenant tables, by any path
  
  `db:doctor` asserts the same, as does the schema test, which also checks that every tenant table is
  owned by the owner and has RLS enabled.
- **The database is provisioned in two steps, and only the first needs more than `CREATEROLE`.**
  1. Creating the instance: a superuser makes `patchgrid_admin`, `LOGIN CREATEROLE CREATEDB` and
     `NOSUPERUSER`, the master user of an RDS instance. Locally that is the Compose init script, in CI the
     service container, and on RDS the provider when the instance is created.
  2. Everything else runs as `patchgrid_admin`: the roles, the databases (owned by the owner), and the
     per-database grants, run as the owner itself. `db:bootstrap` runs this second step, so it works
     unchanged against Compose, CI, Floci and a real RDS instance.

## Consequences

- The role model can be created on RDS, Aurora, Cloud SQL or Azure, which all withhold superuser, so
  the deployment blocker in `HANDOFF.md` is gone.
- Because the bootstrap never runs as a superuser, a privilege it quietly depended on fails locally and
  in CI, not on the day of a real deployment.
- The protection against "the application role can see everything" moves from a role attribute to a
  role relationship, and is asserted at boot like the attribute was. Granting the app role membership
  in the owner, for convenience in some script, now stops the API from starting rather than silently
  turning RLS off.
- `SECURITY DEFINER` functions owned by the owner run exempt from RLS, as they did before, since the
  owner held `BYPASSRLS`. The two that exist, creating and archiving audit partitions, issue DDL and
  return no tenant rows. Any new one must not return tenant rows either.
- An existing volume applies the migration, then re-runs `db:bootstrap`, which removes the attribute.
