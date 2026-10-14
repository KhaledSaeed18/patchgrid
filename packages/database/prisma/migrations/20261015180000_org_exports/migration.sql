-- CreateEnum
CREATE TYPE "OrgExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "OrgExport" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "requestedByMembershipId" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "OrgExportStatus" NOT NULL DEFAULT 'QUEUED',
    "storageKey" TEXT,
    "sizeBytes" BIGINT,
    "readyAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "failure" TEXT,

    CONSTRAINT "OrgExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrgExport_orgId_requestedAt_id_idx" ON "OrgExport"("orgId", "requestedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "OrgExport_orgId_status_expiresAt_idx" ON "OrgExport"("orgId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrgExport_orgId_id_key" ON "OrgExport"("orgId", "id");

-- AddForeignKey
ALTER TABLE "OrgExport" ADD CONSTRAINT "OrgExport_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgExport" ADD CONSTRAINT "OrgExport_orgId_requestedByMembershipId_fkey" FOREIGN KEY ("orgId", "requestedByMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A ready export has its object, its size and its lapse; a failed one says why (ADR-0044).
ALTER TABLE "OrgExport" ADD CONSTRAINT "OrgExport_state_check"
  CHECK (
    ("status" <> 'READY' OR ("storageKey" IS NOT NULL AND "sizeBytes" IS NOT NULL AND "readyAt" IS NOT NULL AND "expiresAt" IS NOT NULL))
    AND ("status" <> 'FAILED' OR "failure" IS NOT NULL)
  );

ALTER TABLE "OrgExport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgExport" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OrgExport"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
