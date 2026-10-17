-- CreateEnum
CREATE TYPE "TicketFactState" AS ENUM ('OPEN', 'RESOLVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClockOutcome" AS ENUM ('NONE', 'RUNNING', 'MET', 'BREACHED');

-- CreateTable
CREATE TABLE "TicketFact" (
    "orgId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "type" "TicketType" NOT NULL,
    "priority" "Priority" NOT NULL,
    "teamId" UUID,
    "categoryId" UUID,
    "assigneeMembershipId" UUID,
    "state" "TicketFactState" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "responseMinutes" INTEGER,
    "resolutionMinutes" INTEGER,
    "response" "ClockOutcome" NOT NULL,
    "resolution" "ClockOutcome" NOT NULL,
    "reopenCount" INTEGER NOT NULL,
    "refreshedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TicketFact_pkey" PRIMARY KEY ("orgId","ticketId")
);

-- CreateIndex
CREATE INDEX "TicketFact_orgId_resolvedAt_idx" ON "TicketFact"("orgId", "resolvedAt");

-- CreateIndex
CREATE INDEX "TicketFact_orgId_createdAt_idx" ON "TicketFact"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketFact_orgId_state_createdAt_idx" ON "TicketFact"("orgId", "state", "createdAt");

-- AddForeignKey
ALTER TABLE "TicketFact" ADD CONSTRAINT "TicketFact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketFact" ADD CONSTRAINT "TicketFact_orgId_ticketId_fkey" FOREIGN KEY ("orgId", "ticketId") REFERENCES "Ticket"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;



ALTER TABLE "TicketFact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TicketFact" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TicketFact"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
