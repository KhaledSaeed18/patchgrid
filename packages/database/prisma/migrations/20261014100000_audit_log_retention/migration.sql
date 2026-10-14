-- ADR-0034 retention: every AuditLog month partition wholly past the longest
-- retention window (7 years) is detached and archived. Like the partition
-- creator, a SECURITY DEFINER door the app role may knock on without holding
-- the privilege behind it.
--
-- * The window is fixed HERE, not passed in, so no caller can archive recent
--   history by sending the wrong date.
-- * An archived month moves to "audit_archive", a schema the app role cannot
--   even see: it keeps its rows, forced RLS and policy, loses its foreign keys
--   (an org or member hard-deleted later must not be blocked by history) and
--   every grant. The schema assertions cover `public`, which it has left.
-- * DETACH takes an exclusive lock on AuditLog, which every mutation writes
--   to; it waits two seconds at most and the job tries again the next day.
-- * Archiving or dropping the archive is an operator's decision.
CREATE SCHEMA audit_archive;
REVOKE ALL ON SCHEMA audit_archive FROM PUBLIC;

CREATE FUNCTION archive_expired_audit_log_partitions() RETURNS SETOF text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
  SET lock_timeout = '2s'
AS $$
DECLARE
  cutoff    timestamp := (now() - interval '7 years') AT TIME ZONE 'UTC';
  partition text;
  month     timestamp;
  fk        text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ensure_audit_log_partition'));
  FOR partition IN
    SELECT child.relname
    FROM pg_inherits
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    WHERE parent.relname = 'AuditLog'
      AND parent.relnamespace = 'public'::regnamespace
      AND child.relname ~ '^AuditLog_[0-9]{4}_[0-9]{2}$'
    ORDER BY child.relname
  LOOP
    month := to_timestamp(substr(partition, 10), 'YYYY_MM')::timestamp;
    CONTINUE WHEN month + interval '1 month' > cutoff;
    EXECUTE format('ALTER TABLE public."AuditLog" DETACH PARTITION public.%I', partition);
    FOR fk IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = format('public.%I', partition)::regclass AND contype = 'f'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', partition, fk);
    END LOOP;
    EXECUTE format('REVOKE ALL ON public.%I FROM patchgrid_app', partition);
    EXECUTE format('ALTER TABLE public.%I SET SCHEMA audit_archive', partition);
    RETURN NEXT partition;
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION archive_expired_audit_log_partitions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_expired_audit_log_partitions() TO patchgrid_app;
