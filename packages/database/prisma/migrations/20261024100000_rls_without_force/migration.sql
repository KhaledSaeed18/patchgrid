-- ADR-0059: a managed Postgres cannot grant BYPASSRLS, so the owner is exempt
-- from the tenant policies by owning the tables, which needs FORCE off. Every
-- other role is bound exactly as before; the API refuses to start if its role
-- is a member of the owner.
--
-- Every forced table the owner has, wherever it lives: `public`, and the
-- archived audit months in `audit_archive`.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relforcerowsecurity
      AND n.nspname IN ('public', 'audit_archive')
      AND pg_has_role(c.relowner, 'USAGE')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY', t.nspname, t.relname);
  END LOOP;
END
$$;

-- New audit months get the template the generator emits: enabled, the policy,
-- no FORCE. Replacing the body keeps the owner, SECURITY DEFINER and the grant.
CREATE OR REPLACE FUNCTION ensure_audit_log_partition(at timestamptz) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  month_start timestamp := date_trunc('month', at AT TIME ZONE 'UTC');
  partition   text      := format('AuditLog_%s', to_char(month_start, 'YYYY_MM'));
  policy      text      := '"orgId" = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ensure_audit_log_partition'));
  IF to_regclass(format('public.%I', partition)) IS NOT NULL THEN
    RETURN partition;
  END IF;
  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public."AuditLog" FOR VALUES FROM (%L) TO (%L)',
    partition,
    month_start AT TIME ZONE 'UTC',
    (month_start + interval '1 month') AT TIME ZONE 'UTC'
  );
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', partition);
  EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (%s) WITH CHECK (%s)', partition, policy, policy);
  RETURN partition;
END
$$;
