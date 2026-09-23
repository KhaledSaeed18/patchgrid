#!/bin/bash
# Runs ONCE, when the data volume is empty. Creates the two application roles,
# the test database, and the per-database privileges.
#
# `pnpm db:bootstrap` performs the same work against an existing volume — they
# must stay in step, which is why the per-database part is one shared SQL file.
set -euo pipefail

OWNER_PASSWORD="${PATCHGRID_OWNER_PASSWORD:?PATCHGRID_OWNER_PASSWORD is required}"
APP_PASSWORD="${PATCHGRID_APP_PASSWORD:?PATCHGRID_APP_PASSWORD is required}"
TEST_DB="${POSTGRES_TEST_DB:-patchgrid_test}"
SHADOW_DB="${POSTGRES_SHADOW_DB:-patchgrid_shadow}"

psql() { command psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" "$@"; }

echo "[patchgrid] creating roles"
# The owner runs migrations and the test harness, so it needs BYPASSRLS:
# FORCE ROW LEVEL SECURITY means owning a table is NOT enough to read it.
psql --dbname "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'patchgrid_owner') THEN
    CREATE ROLE patchgrid_owner LOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'patchgrid_app') THEN
    CREATE ROLE patchgrid_app LOGIN;
  END IF;
END \$\$;
SQL
psql --dbname "$POSTGRES_DB" -c "ALTER ROLE patchgrid_owner LOGIN BYPASSRLS  PASSWORD '${OWNER_PASSWORD}'"
psql --dbname "$POSTGRES_DB" -c "ALTER ROLE patchgrid_app   LOGIN NOBYPASSRLS PASSWORD '${APP_PASSWORD}'"

echo "[patchgrid] transferring database ownership"
# The image creates POSTGRES_DB owned by the superuser. The owner role needs to
# own it so that `prisma migrate reset` can drop and recreate the public schema.
psql --dbname "$POSTGRES_DB" -c "ALTER DATABASE ${POSTGRES_DB} OWNER TO patchgrid_owner"

echo "[patchgrid] creating ${TEST_DB}"
psql --dbname "$POSTGRES_DB" -tc "SELECT 1 FROM pg_database WHERE datname = '${TEST_DB}'" \
  | grep -q 1 || psql --dbname "$POSTGRES_DB" -c "CREATE DATABASE ${TEST_DB} OWNER patchgrid_owner"

# Prisma diffs migrations against a scratch database it wipes at will. The owner
# role has no CREATEDB, so it gets one to own instead. Not bootstrapped: Prisma
# resets it, and nothing but the migration engine ever connects.
echo "[patchgrid] creating ${SHADOW_DB}"
psql --dbname "$POSTGRES_DB" -tc "SELECT 1 FROM pg_database WHERE datname = '${SHADOW_DB}'" \
  | grep -q 1 || psql --dbname "$POSTGRES_DB" -c "CREATE DATABASE ${SHADOW_DB} OWNER patchgrid_owner"

for db in "$POSTGRES_DB" "$TEST_DB"; do
  echo "[patchgrid] bootstrapping ${db}"
  psql --dbname "$db" -f /opt/patchgrid/sql/bootstrap.sql
done

echo "[patchgrid] done"
