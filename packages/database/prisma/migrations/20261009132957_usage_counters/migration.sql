-- CreateEnum
CREATE TYPE "UsageMetric" AS ENUM ('AGENT_SEATS', 'TICKETS_CREATED', 'STORAGE_BYTES', 'AUTOMATION_RULES', 'KB_ARTICLES');

-- CreateTable
CREATE TABLE "UsageCounter" (
    "orgId" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "metric" "UsageMetric" NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("orgId","period","metric")
);

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- Hand-written below this line (ENGINEERING.md §Schema changes).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_value_check" CHECK ("value" >= 0);
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_period_check" CHECK (
  CASE "metric" WHEN 'TICKETS_CREATED' THEN "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' ELSE "period" = 'current' END
);

ALTER TABLE "UsageCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageCounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "UsageCounter"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Workspaces created before the counter existed start from what they hold now.
INSERT INTO "UsageCounter" ("orgId", "period", "metric", "value", "updatedAt")
SELECT "orgId", 'current', 'AGENT_SEATS', count(*), now()
  FROM "Membership"
 WHERE "status" = 'ACTIVE' AND "kind" = 'HUMAN' AND "role" <> 'REQUESTER'
 GROUP BY "orgId";
