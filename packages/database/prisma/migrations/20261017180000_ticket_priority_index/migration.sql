-- CreateIndex
CREATE INDEX "Ticket_orgId_priority_createdAt_id_idx" ON "Ticket"("orgId", "priority", "createdAt" DESC, "id" DESC);

