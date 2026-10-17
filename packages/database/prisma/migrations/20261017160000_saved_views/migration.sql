-- CreateTable
CREATE TABLE "SavedView" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "ownerMembershipId" UUID NOT NULL,
    "teamId" UUID,
    "name" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedView_orgId_teamId_idx" ON "SavedView"("orgId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedView_orgId_id_key" ON "SavedView"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SavedView_orgId_ownerMembershipId_name_key" ON "SavedView"("orgId", "ownerMembershipId", "name");

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_orgId_ownerMembershipId_fkey" FOREIGN KEY ("orgId", "ownerMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_orgId_teamId_fkey" FOREIGN KEY ("orgId", "teamId") REFERENCES "Team"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;



ALTER TABLE "SavedView" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SavedView" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SavedView"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
