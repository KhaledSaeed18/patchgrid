-- CreateEnum
CREATE TYPE "AuditActorKind" AS ENUM ('MEMBER', 'SERVICE', 'SYSTEM', 'PLATFORM');

-- AlterEnum
ALTER TYPE "MembershipStatus" ADD VALUE 'REMOVED';

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "diff" JSONB NOT NULL DEFAULT '{}',
    "actorKind" "AuditActorKind" NOT NULL,
    "actorMembershipId" UUID,
    "actorPlatformAdminId" UUID,
    "supportSessionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id","createdAt")
) PARTITION BY RANGE ("createdAt"); -- hand-edited: Prisma cannot declare partitioning (ADR-0034)

-- CreateIndex
CREATE INDEX "AuditLog_orgId_createdAt_id_idx" ON "AuditLog"("orgId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_orgId_entityType_entityId_createdAt_idx" ON "AuditLog"("orgId", "entityType", "entityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_orgId_actorMembershipId_createdAt_idx" ON "AuditLog"("orgId", "actorMembershipId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_orgId_action_createdAt_idx" ON "AuditLog"("orgId", "action", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_orgId_actorMembershipId_fkey" FOREIGN KEY ("orgId", "actorMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorPlatformAdminId_fkey" FOREIGN KEY ("actorPlatformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- Hand-written below this line (ENGINEERING.md §Schema changes).
-- ════════════════════════════════════════════════════════════════════════════

-- The actor columns agree with the actor kind: a member's change names the
-- membership, a platform admin's names the admin. SYSTEM and SERVICE rows may
-- name a membership (a service account is one) or nothing.
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actor_check" CHECK (
  ("actorKind" <> 'MEMBER' OR "actorMembershipId" IS NOT NULL) AND
  ("actorKind" <> 'PLATFORM' OR "actorPlatformAdminId" IS NOT NULL) AND
  ("actorKind" = 'PLATFORM' OR "actorPlatformAdminId" IS NULL)
);

-- Tenant isolation on the parent: governs every query THROUGH "AuditLog".
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditLog"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Month partitions (ADR-0034). A query naming a partition directly is checked
-- against the PARTITION's policies, not the parent's, so each partition gets
-- the same forced template policy here. SECURITY DEFINER runs this as the
-- owner, which is how the application role can make next month's partition
-- without ever holding CREATE; it can make nothing else. Idempotent, and
-- serialised so two callers racing at a month boundary do not collide.
CREATE FUNCTION ensure_audit_log_partition(at timestamptz) RETURNS text
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
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', partition);
  EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (%s) WITH CHECK (%s)', partition, policy, policy);
  RETURN partition;
END
$$;

REVOKE ALL ON FUNCTION ensure_audit_log_partition(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_audit_log_partition(timestamptz) TO patchgrid_app;

-- Usable before the API first boots; the API keeps a month ahead from then on.
SELECT ensure_audit_log_partition(now());
SELECT ensure_audit_log_partition(now() + interval '1 month');
