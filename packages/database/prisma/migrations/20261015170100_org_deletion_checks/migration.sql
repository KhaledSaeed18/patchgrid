-- A workspace pending deletion says since when; a tombstone says when it was
-- purged, and nothing else is one (ADR-0043). Separate from the migration that
-- adds 'DELETED', which a transaction cannot use in the statement that adds it.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_deletion_check"
  CHECK (
    ("status" <> 'PENDING_DELETION' OR "deletionRequestedAt" IS NOT NULL)
    AND (("status" = 'DELETED') = ("deletedAt" IS NOT NULL))
  );
