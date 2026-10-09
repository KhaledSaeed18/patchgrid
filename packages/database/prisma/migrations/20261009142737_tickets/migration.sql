-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('INCIDENT', 'SERVICE_REQUEST', 'PROBLEM', 'CHANGE');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED', 'KNOWN_ERROR', 'DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'IMPLEMENTED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "Impact" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "Urgency" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TicketSource" AS ENUM ('PORTAL', 'CONSOLE', 'EMAIL', 'API');

-- CreateEnum
CREATE TYPE "CommentVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- CreateEnum
CREATE TYPE "CommentAuthorKind" AS ENUM ('MEMBER', 'SERVICE', 'SYSTEM', 'AUTOMATION');

-- CreateTable
CREATE TABLE "TicketCounter" (
    "orgId" UUID NOT NULL,
    "type" "TicketType" NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TicketCounter_pkey" PRIMARY KEY ("orgId","type")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "depth" INTEGER NOT NULL,
    "defaultTeamId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SLAPolicy" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "ticketType" "TicketType" NOT NULL,
    "priority" "Priority" NOT NULL,
    "responseTargetMinutes" INTEGER NOT NULL,
    "resolutionTargetMinutes" INTEGER NOT NULL,
    "responseWarningMinutes" INTEGER NOT NULL,
    "resolutionWarningMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SLAPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "TicketType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'NEW',
    "version" INTEGER NOT NULL DEFAULT 1,
    "impact" "Impact" NOT NULL,
    "urgency" "Urgency" NOT NULL,
    "priority" "Priority" NOT NULL,
    "categoryId" UUID,
    "requesterMembershipId" UUID NOT NULL,
    "assigneeMembershipId" UUID,
    "teamId" UUID,
    "slaPolicyId" UUID,
    "responseClockStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "resolutionClockStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "respondBy" TIMESTAMPTZ(3),
    "resolveBy" TIMESTAMPTZ(3),
    "respondedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "pausedAt" TIMESTAMPTZ(3),
    "pausedMinutes" INTEGER NOT NULL DEFAULT 0,
    "responseBreached" BOOLEAN NOT NULL DEFAULT false,
    "resolutionBreached" BOOLEAN NOT NULL DEFAULT false,
    "responseWarningSentAt" TIMESTAMPTZ(3),
    "resolutionWarningSentAt" TIMESTAMPTZ(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "source" "TicketSource" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "authorMembershipId" UUID,
    "authorKind" "CommentAuthorKind" NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "CommentVisibility" NOT NULL,
    "editedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "deletedByMembershipId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketWatcher" (
    "orgId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "addedByMembershipId" UUID NOT NULL,
    "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketWatcher_pkey" PRIMARY KEY ("orgId","ticketId","membershipId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_orgId_id_key" ON "Category"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Category_orgId_parentId_name_key" ON "Category"("orgId", "parentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_root_name_key" ON "Category"("orgId", "name") WHERE ("parentId" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "SLAPolicy_orgId_id_key" ON "SLAPolicy"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SLAPolicy_orgId_ticketType_priority_key" ON "SLAPolicy"("orgId", "ticketType", "priority");

-- CreateIndex
CREATE INDEX "Ticket_orgId_createdAt_id_idx" ON "Ticket"("orgId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ticket_orgId_status_createdAt_idx" ON "Ticket"("orgId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Ticket_orgId_assigneeMembershipId_status_idx" ON "Ticket"("orgId", "assigneeMembershipId", "status");

-- CreateIndex
CREATE INDEX "Ticket_orgId_teamId_status_idx" ON "Ticket"("orgId", "teamId", "status");

-- CreateIndex
CREATE INDEX "Ticket_orgId_requesterMembershipId_createdAt_idx" ON "Ticket"("orgId", "requesterMembershipId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Ticket_orgId_categoryId_idx" ON "Ticket"("orgId", "categoryId");

-- CreateIndex
CREATE INDEX "Ticket_open_resolveBy_idx" ON "Ticket"("orgId", "resolveBy") WHERE ("resolveBy" IS NOT NULL AND "status" IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'));

-- CreateIndex
CREATE INDEX "Ticket_unresponded_respondBy_idx" ON "Ticket"("orgId", "respondBy") WHERE ("respondedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_orgId_id_key" ON "Ticket"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_orgId_type_number_key" ON "Ticket"("orgId", "type", "number");

-- CreateIndex
CREATE INDEX "Comment_orgId_ticketId_createdAt_idx" ON "Comment"("orgId", "ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Comment_orgId_id_key" ON "Comment"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Comment_orgId_ticketId_id_key" ON "Comment"("orgId", "ticketId", "id");

-- CreateIndex
CREATE INDEX "TicketWatcher_orgId_membershipId_idx" ON "TicketWatcher"("orgId", "membershipId");

-- AddForeignKey
ALTER TABLE "TicketCounter" ADD CONSTRAINT "TicketCounter_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_orgId_parentId_fkey" FOREIGN KEY ("orgId", "parentId") REFERENCES "Category"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_orgId_defaultTeamId_fkey" FOREIGN KEY ("orgId", "defaultTeamId") REFERENCES "Team"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SLAPolicy" ADD CONSTRAINT "SLAPolicy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_categoryId_fkey" FOREIGN KEY ("orgId", "categoryId") REFERENCES "Category"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_requesterMembershipId_fkey" FOREIGN KEY ("orgId", "requesterMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_assigneeMembershipId_fkey" FOREIGN KEY ("orgId", "assigneeMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_teamId_fkey" FOREIGN KEY ("orgId", "teamId") REFERENCES "Team"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orgId_slaPolicyId_fkey" FOREIGN KEY ("orgId", "slaPolicyId") REFERENCES "SLAPolicy"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_orgId_ticketId_fkey" FOREIGN KEY ("orgId", "ticketId") REFERENCES "Ticket"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_orgId_authorMembershipId_fkey" FOREIGN KEY ("orgId", "authorMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_orgId_deletedByMembershipId_fkey" FOREIGN KEY ("orgId", "deletedByMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWatcher" ADD CONSTRAINT "TicketWatcher_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWatcher" ADD CONSTRAINT "TicketWatcher_orgId_ticketId_fkey" FOREIGN KEY ("orgId", "ticketId") REFERENCES "Ticket"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWatcher" ADD CONSTRAINT "TicketWatcher_orgId_membershipId_fkey" FOREIGN KEY ("orgId", "membershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWatcher" ADD CONSTRAINT "TicketWatcher_orgId_addedByMembershipId_fkey" FOREIGN KEY ("orgId", "addedByMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- Hand-written below this line (ENGINEERING.md §Schema changes). The services
-- are the readable rules; these are the ones that cannot be forgotten.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "TicketCounter" ADD CONSTRAINT "TicketCounter_nextValue_check" CHECK ("nextValue" >= 1);

-- Three levels, and a level is exactly "how many parents" (DOMAIN.md §5).
ALTER TABLE "Category" ADD CONSTRAINT "Category_depth_check"
  CHECK ("depth" BETWEEN 1 AND 3 AND ("depth" = 1) = ("parentId" IS NULL));

-- Incidents and Service Requests only; a warning that fires before the ticket
-- exists is useless (DOMAIN.md §4.1).
ALTER TABLE "SLAPolicy" ADD CONSTRAINT "SLAPolicy_type_check"
  CHECK ("ticketType" IN ('INCIDENT', 'SERVICE_REQUEST'));
ALTER TABLE "SLAPolicy" ADD CONSTRAINT "SLAPolicy_targets_check" CHECK (
  "responseTargetMinutes" > 0 AND "resolutionTargetMinutes" > 0 AND
  "responseWarningMinutes" > 0 AND "responseWarningMinutes" < "responseTargetMinutes" AND
  "resolutionWarningMinutes" > 0 AND "resolutionWarningMinutes" < "resolutionTargetMinutes"
);

-- Each type's statuses (DOMAIN.md §2, ADR-0002): a service bug becomes a
-- database error rather than an impossible row.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_type_status_check" CHECK (
  CASE "type"
    WHEN 'INCIDENT' THEN "status" IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED')
    WHEN 'SERVICE_REQUEST' THEN "status" IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'CANCELLED')
    WHEN 'PROBLEM' THEN "status" IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'KNOWN_ERROR', 'RESOLVED', 'CLOSED')
    WHEN 'CHANGE' THEN "status" IN ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'IN_PROGRESS', 'IMPLEMENTED', 'ROLLED_BACK', 'CLOSED', 'CANCELLED')
  END
);

-- Priority is the matrix's answer and nothing else (DOMAIN.md §3).
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_priority_matrix_check" CHECK (
  "priority" = CASE
    WHEN "impact" = 'HIGH' AND "urgency" = 'HIGH' THEN 'CRITICAL'::"Priority"
    WHEN "impact" = 'HIGH' AND "urgency" = 'MEDIUM' THEN 'HIGH'::"Priority"
    WHEN "impact" = 'MEDIUM' AND "urgency" = 'HIGH' THEN 'HIGH'::"Priority"
    WHEN "impact" = 'LOW' AND "urgency" IN ('LOW', 'MEDIUM') THEN 'LOW'::"Priority"
    WHEN "impact" = 'MEDIUM' AND "urgency" = 'LOW' THEN 'LOW'::"Priority"
    ELSE 'MEDIUM'::"Priority"
  END
);

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_counts_check" CHECK (
  "number" >= 1 AND "version" >= 1 AND "pausedMinutes" >= 0 AND "reopenCount" >= 0
);

-- Only the clocked types carry a policy.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_sla_type_check"
  CHECK ("slaPolicyId" IS NULL OR "type" IN ('INCIDENT', 'SERVICE_REQUEST'));

-- A member's comment names its author; a deletion names who deleted it.
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_author_check"
  CHECK ("authorKind" <> 'MEMBER' OR "authorMembershipId" IS NOT NULL);
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_deletion_check"
  CHECK (("deletedAt" IS NULL) = ("deletedByMembershipId" IS NULL));

-- Tenant isolation, from the one template (src/rls.ts).
ALTER TABLE "TicketCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TicketCounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TicketCounter"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "Category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Category" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Category"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "SLAPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SLAPolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SLAPolicy"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "Ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ticket" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Ticket"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "Comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Comment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Comment"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "TicketWatcher" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TicketWatcher" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TicketWatcher"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

