-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TICKET_CREATED', 'TICKET_RAISED_FOR_YOU', 'TICKET_ASSIGNED', 'COMMENT_PUBLIC', 'COMMENT_INTERNAL', 'STATUS_CHANGED', 'TICKET_REOPENED', 'WATCHER_ADDED', 'SLA_WARNING', 'SLA_BREACHED');

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "ticketId" UUID,
    "dedupeKey" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_orgId_userId_readAt_createdAt_idx" ON "Notification"("orgId", "userId", "readAt", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_orgId_id_key" ON "Notification"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_unread_dedupe_key" ON "Notification"("orgId", "membershipId", "dedupeKey") WHERE ("readAt" IS NULL);

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orgId_membershipId_fkey" FOREIGN KEY ("orgId", "membershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orgId_userId_fkey" FOREIGN KEY ("orgId", "userId") REFERENCES "Membership"("orgId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orgId_ticketId_fkey" FOREIGN KEY ("orgId", "ticketId") REFERENCES "Ticket"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A burst collapses into one row whose count grows; it never shrinks below one.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_count_check" CHECK ("count" >= 1);

-- Tenant isolation, from the one template (src/rls.ts).
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Notification"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
