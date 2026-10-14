-- CreateEnum
CREATE TYPE "AuthVerdict" AS ENUM ('PASS', 'FAIL', 'NONE');

-- CreateEnum
CREATE TYPE "InboundOutcome" AS ENUM ('RECEIVED', 'CREATED', 'THREADED', 'UNAUTHENTICATED', 'UNKNOWN_SENDER', 'AUTO_REPLY', 'RATE_LIMITED', 'FAILED');

-- CreateTable
CREATE TABLE "InboundEmail" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "messageKey" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "authVerdict" "AuthVerdict" NOT NULL DEFAULT 'NONE',
    "outcome" "InboundOutcome" NOT NULL DEFAULT 'RECEIVED',
    "senderMembershipId" UUID,
    "ticketId" UUID,
    "rawStorageKey" TEXT NOT NULL,
    "skippedAttachments" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "InboundEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundEmail_orgId_receivedAt_id_idx" ON "InboundEmail"("orgId", "receivedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "InboundEmail_orgId_fromAddress_receivedAt_idx" ON "InboundEmail"("orgId", "fromAddress", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmail_orgId_id_key" ON "InboundEmail"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmail_orgId_messageKey_key" ON "InboundEmail"("orgId", "messageKey");

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_orgId_senderMembershipId_fkey" FOREIGN KEY ("orgId", "senderMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_orgId_ticketId_fkey" FOREIGN KEY ("orgId", "ticketId") REFERENCES "Ticket"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A ticket only once something became of the message; trusted senders only for what was acted on.
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_ticket_check"
  CHECK (("outcome" IN ('CREATED', 'THREADED')) = ("ticketId" IS NOT NULL));
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_acted_check"
  CHECK ("outcome" NOT IN ('CREATED', 'THREADED') OR ("authVerdict" = 'PASS' AND "senderMembershipId" IS NOT NULL));

ALTER TABLE "InboundEmail" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InboundEmail" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "InboundEmail"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
