-- CreateEnum
CREATE TYPE "SupportEndReason" AS ENUM ('EXPIRED', 'REVOKED', 'AUDIT_FAILED');

-- CreateTable
CREATE TABLE "SupportSession" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "platformAdminId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByMembershipId" UUID,
    "grantedAt" TIMESTAMPTZ(3),
    "declinedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "firstUsedAt" TIMESTAMPTZ(3),
    "revokedByMembershipId" UUID,
    "endedAt" TIMESTAMPTZ(3),
    "endReason" "SupportEndReason",

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportSession_orgId_requestedAt_id_idx" ON "SupportSession"("orgId", "requestedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "SupportSession_orgId_endedAt_expiresAt_idx" ON "SupportSession"("orgId", "endedAt", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportSession_orgId_id_key" ON "SupportSession"("orgId", "id");

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_orgId_decidedByMembershipId_fkey" FOREIGN KEY ("orgId", "decidedByMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_orgId_revokedByMembershipId_fkey" FOREIGN KEY ("orgId", "revokedByMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A session is decided once: granted with an expiry, or declined; ended only after it was granted (ADR-0041).
-- A session is decided once: granted with an expiry, or declined; ended only after it was granted (ADR-0041).
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_decision_check"
  CHECK (NOT ("grantedAt" IS NOT NULL AND "declinedAt" IS NOT NULL));
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_grant_check"
  CHECK (("grantedAt" IS NULL) = ("expiresAt" IS NULL));
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_window_check"
  CHECK ("expiresAt" IS NULL OR "expiresAt" <= "grantedAt" + interval '72 hours');
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_end_check"
  CHECK (("endedAt" IS NULL) = ("endReason" IS NULL) AND ("endedAt" IS NULL OR "grantedAt" IS NOT NULL));

ALTER TABLE "SupportSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SupportSession"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
