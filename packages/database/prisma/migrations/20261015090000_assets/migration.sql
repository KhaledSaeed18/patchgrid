-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('LAPTOP', 'DESKTOP', 'MONITOR', 'PHONE', 'TABLET', 'PRINTER', 'NETWORK', 'SERVER', 'SOFTWARE', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('IN_STOCK', 'IN_USE', 'IN_REPAIR', 'RETIRED');

-- CreateTable
CREATE TABLE "Asset" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'IN_STOCK',
    "serialNumber" TEXT,
    "ownerMembershipId" UUID,
    "purchaseDate" DATE,
    "warrantyExpiresAt" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketAsset" (
    "orgId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAsset_pkey" PRIMARY KEY ("orgId","ticketId","assetId")
);

-- CreateIndex
CREATE INDEX "Asset_orgId_name_id_idx" ON "Asset"("orgId", "name", "id");

-- CreateIndex
CREATE INDEX "Asset_orgId_ownerMembershipId_idx" ON "Asset"("orgId", "ownerMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_orgId_id_key" ON "Asset"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_orgId_serialNumber_key" ON "Asset"("orgId", "serialNumber");

-- CreateIndex
CREATE INDEX "TicketAsset_orgId_assetId_createdAt_idx" ON "TicketAsset"("orgId", "assetId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_orgId_ownerMembershipId_fkey" FOREIGN KEY ("orgId", "ownerMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAsset" ADD CONSTRAINT "TicketAsset_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAsset" ADD CONSTRAINT "TicketAsset_orgId_ticketId_fkey" FOREIGN KEY ("orgId", "ticketId") REFERENCES "Ticket"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAsset" ADD CONSTRAINT "TicketAsset_orgId_assetId_fkey" FOREIGN KEY ("orgId", "assetId") REFERENCES "Asset"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- An owner's dates in order; a name that says something (DOMAIN.md §9.3).
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_warranty_check"
  CHECK ("purchaseDate" IS NULL OR "warrantyExpiresAt" IS NULL OR "warrantyExpiresAt" >= "purchaseDate");
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_name_check" CHECK (length(btrim("name")) > 0);

ALTER TABLE "Asset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Asset" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Asset"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "TicketAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TicketAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TicketAsset"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
