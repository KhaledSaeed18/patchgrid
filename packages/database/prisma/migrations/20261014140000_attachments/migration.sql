-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING', 'READY');

-- CreateTable
CREATE TABLE "Attachment" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "commentId" UUID,
    "uploaderMembershipId" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "declaredMimeType" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attachment_orgId_ticketId_createdAt_idx" ON "Attachment"("orgId", "ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "Attachment_orgId_status_createdAt_idx" ON "Attachment"("orgId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_orgId_id_key" ON "Attachment"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_orgId_storageKey_key" ON "Attachment"("orgId", "storageKey");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_orgId_ticketId_fkey" FOREIGN KEY ("orgId", "ticketId") REFERENCES "Ticket"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_orgId_ticketId_commentId_fkey" FOREIGN KEY ("orgId", "ticketId", "commentId") REFERENCES "Comment"("orgId", "ticketId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_orgId_uploaderMembershipId_fkey" FOREIGN KEY ("orgId", "uploaderMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A size the presign signed exactly (ADR-0005); a mime type only once sniffed.
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_size_check" CHECK ("sizeBytes" > 0);
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_ready_check"
  CHECK (("status" = 'READY') = ("mimeType" IS NOT NULL AND "completedAt" IS NOT NULL));

-- Tenant isolation, from the one template (src/rls.ts).
ALTER TABLE "Attachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Attachment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Attachment"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
