-- M9 load check: the `assigned` and `teams` list branches are keyset-paged on
-- (createdAt, id). With 100k tickets a busy assignee's page sorted ~10k rows;
-- indexed on the sort as well, a page is an index range like the others.
CREATE INDEX "Ticket_orgId_assigneeMembershipId_createdAt_id_idx" ON "Ticket"("orgId", "assigneeMembershipId", "createdAt" DESC, "id" DESC);
CREATE INDEX "Ticket_orgId_teamId_createdAt_id_idx" ON "Ticket"("orgId", "teamId", "createdAt" DESC, "id" DESC);
