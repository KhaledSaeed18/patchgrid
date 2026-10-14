-- The inbox orders by "updatedAt", which a folded burst moves (DOMAIN.md §8):
-- ordered by "createdAt", a reply on a week-old unread thread stayed a week deep.
DROP INDEX "Notification_orgId_userId_readAt_createdAt_idx";

CREATE INDEX "Notification_orgId_userId_updatedAt_idx" ON "Notification"("orgId", "userId", "updatedAt" DESC);
