#!/bin/bash
# Runs ONCE, when the data volume is empty, as the image's superuser: the step a
# managed Postgres's provider takes when it makes an instance (ADR-0059). It
# creates the instance's admin, a role with CREATEROLE and CREATEDB and nothing
# more, as RDS's master user is. Everything after this — the owner and app
# roles, the databases, the grants — is `pnpm db:bootstrap`, run as that admin.
set -euo pipefail

ADMIN_PASSWORD="${PATCHGRID_ADMIN_PASSWORD:?PATCHGRID_ADMIN_PASSWORD is required}"

echo "[patchgrid] creating the instance admin"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v admin_password="$ADMIN_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE patchgrid_admin LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'patchgrid_admin') \gexec
ALTER ROLE patchgrid_admin LOGIN CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS NOREPLICATION PASSWORD :'admin_password';
SQL
echo "[patchgrid] done; run pnpm db:bootstrap for the roles and databases"
