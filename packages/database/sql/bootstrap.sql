-- Per-database setup. Idempotent. Requires superuser (CREATE EXTENSION and
-- ALTER SCHEMA OWNER are not available to the owner role).
--
-- Run against EVERY database the application touches — `patchgrid` and
-- `patchgrid_test` — because privileges and default privileges are per-database.

CREATE EXTENSION IF NOT EXISTS "vector";

-- The owner role owns the schema and creates every object in it.
ALTER SCHEMA public OWNER TO patchgrid_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO patchgrid_owner;
GRANT USAGE ON SCHEMA public TO patchgrid_app;

-- Privileges on objects that exist RIGHT NOW.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO patchgrid_app;
GRANT USAGE, SELECT               ON ALL SEQUENCES IN SCHEMA public TO patchgrid_app;

-- …and on objects the owner creates LATER. This is the line people forget:
-- without it every future migration ships a table the application cannot read,
-- and only in whichever environment ran the migration. The tenancy suite asserts
-- `has_table_privilege` for every tenant-owned table so a miss fails CI, not prod.
ALTER DEFAULT PRIVILEGES FOR ROLE patchgrid_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO patchgrid_app;
ALTER DEFAULT PRIVILEGES FOR ROLE patchgrid_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO patchgrid_app;

-- Deliberately NOT granted to patchgrid_app: CREATE on the schema, and any form
-- of BYPASSRLS. The application cannot create tables and cannot disable its own
-- isolation — asserted at API boot (ADR-0015, ADR-0022).
