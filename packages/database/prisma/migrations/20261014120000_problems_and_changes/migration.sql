-- CreateEnum
CREATE TYPE "ChangeRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LinkRelation" AS ENUM ('CAUSED_BY', 'RELATES_TO', 'RESOLVED_BY', 'DUPLICATE_OF');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'CHANGE_AWAITING_APPROVAL';
ALTER TYPE "NotificationType" ADD VALUE 'CHANGE_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'CHANGE_REJECTED';

-- CreateTable
CREATE TABLE "ProblemDetails" (
    "orgId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "rootCause" TEXT,
    "workaround" TEXT,
    "knownErrorAt" TIMESTAMPTZ(3),

    CONSTRAINT "ProblemDetails_pkey" PRIMARY KEY ("orgId","ticketId")
);

-- CreateTable
CREATE TABLE "ChangeDetails" (
    "orgId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "plannedStart" TIMESTAMPTZ(3),
    "plannedEnd" TIMESTAMPTZ(3),
    "risk" "ChangeRisk",
    "implementationPlan" TEXT,
    "rollbackPlan" TEXT,
    "outcomeNotes" TEXT,

    CONSTRAINT "ChangeDetails_pkey" PRIMARY KEY ("orgId","ticketId")
);

-- CreateTable
CREATE TABLE "ChangeApproval" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "approverMembershipId" UUID NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "selfApproved" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChangeApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketLink" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "fromTicketId" UUID NOT NULL,
    "toTicketId" UUID NOT NULL,
    "relation" "LinkRelation" NOT NULL,
    "createdByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangeApproval_orgId_ticketId_decidedAt_idx" ON "ChangeApproval"("orgId", "ticketId", "decidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeApproval_orgId_id_key" ON "ChangeApproval"("orgId", "id");

-- CreateIndex
CREATE INDEX "TicketLink_orgId_toTicketId_idx" ON "TicketLink"("orgId", "toTicketId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketLink_orgId_id_key" ON "TicketLink"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TicketLink_orgId_fromTicketId_toTicketId_relation_key" ON "TicketLink"("orgId", "fromTicketId", "toTicketId", "relation");

-- AddForeignKey
ALTER TABLE "ProblemDetails" ADD CONSTRAINT "ProblemDetails_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemDetails" ADD CONSTRAINT "ProblemDetails_orgId_ticketId_fkey" FOREIGN KEY ("orgId", "ticketId") REFERENCES "Ticket"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeDetails" ADD CONSTRAINT "ChangeDetails_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeDetails" ADD CONSTRAINT "ChangeDetails_orgId_ticketId_fkey" FOREIGN KEY ("orgId", "ticketId") REFERENCES "Ticket"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeApproval" ADD CONSTRAINT "ChangeApproval_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeApproval" ADD CONSTRAINT "ChangeApproval_orgId_ticketId_fkey" FOREIGN KEY ("orgId", "ticketId") REFERENCES "Ticket"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeApproval" ADD CONSTRAINT "ChangeApproval_orgId_approverMembershipId_fkey" FOREIGN KEY ("orgId", "approverMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_orgId_fromTicketId_fkey" FOREIGN KEY ("orgId", "fromTicketId") REFERENCES "Ticket"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_orgId_toTicketId_fkey" FOREIGN KEY ("orgId", "toTicketId") REFERENCES "Ticket"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_orgId_createdByMembershipId_fkey" FOREIGN KEY ("orgId", "createdByMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- One fact per row (DOMAIN.md §1): never a ticket linked to itself, and a
-- symmetric RELATES_TO stored once, lower id first, so (a, b) and (b, a)
-- cannot both exist.
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_not_self_check" CHECK ("fromTicketId" <> "toTicketId");
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_relates_to_normalised_check"
  CHECK ("relation" <> 'RELATES_TO' OR "fromTicketId" < "toTicketId");

-- A planned window ends after it starts.
ALTER TABLE "ChangeDetails" ADD CONSTRAINT "ChangeDetails_window_check"
  CHECK ("plannedStart" IS NULL OR "plannedEnd" IS NULL OR "plannedEnd" > "plannedStart");

-- A rejection says why; only an approval can be the owner's own (DOMAIN.md §2.3).
ALTER TABLE "ChangeApproval" ADD CONSTRAINT "ChangeApproval_reason_check"
  CHECK ("decision" <> 'REJECTED' OR "reason" IS NOT NULL);
ALTER TABLE "ChangeApproval" ADD CONSTRAINT "ChangeApproval_self_check"
  CHECK (NOT "selfApproved" OR "decision" = 'APPROVED');

-- DOMAIN.md §2.2 lets a Problem be cancelled from any non-terminal status;
-- the M2 constraint left CANCELLED out of the Problem set.
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_type_status_check";
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_type_status_check" CHECK (
  CASE "type"
    WHEN 'INCIDENT' THEN "status" IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED')
    WHEN 'SERVICE_REQUEST' THEN "status" IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED')
    WHEN 'PROBLEM' THEN "status" IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'KNOWN_ERROR', 'RESOLVED', 'CLOSED', 'CANCELLED')
    WHEN 'CHANGE' THEN "status" IN ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'IN_PROGRESS', 'IMPLEMENTED', 'ROLLED_BACK', 'CLOSED', 'CANCELLED')
  END
);

-- Tenant isolation, from the one template (src/rls.ts).
ALTER TABLE "ProblemDetails" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProblemDetails" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProblemDetails"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "ChangeDetails" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChangeDetails" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ChangeDetails"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "ChangeApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChangeApproval" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ChangeApproval"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "TicketLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TicketLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TicketLink"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
