-- A duplicate stands for exactly one survivor (DOMAIN.md §1). The service
-- follows a target to its survivor and refuses chains under row locks; this
-- is the database saying the same, so a race the service misses is an error
-- rather than a ticket with two survivors.
CREATE UNIQUE INDEX "TicketLink_one_survivor" ON "TicketLink"("orgId", "fromTicketId") WHERE (relation = 'DUPLICATE_OF'::"LinkRelation");
