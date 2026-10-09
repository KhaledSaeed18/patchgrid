-- AlterTable — hand-edited: GENERATED ALWAYS, which Prisma cannot declare.
-- Title outweighs description; English stemming, so "printers" finds "printer".
ALTER TABLE "Ticket" ADD COLUMN "searchVector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("description", '')), 'B')
) STORED;

-- CreateIndex
CREATE INDEX "Ticket_searchVector_idx" ON "Ticket" USING GIN ("searchVector");
