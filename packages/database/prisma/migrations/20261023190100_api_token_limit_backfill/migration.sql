-- Each workspace starts at its unrevoked tokens, as the nightly usage-reconcile
-- would count them, so no workspace is over its limit by an empty counter.
INSERT INTO "UsageCounter" ("orgId", "period", "metric", "value", "updatedAt")
SELECT "orgId", 'current', 'API_TOKENS'::"UsageMetric", count(*), now()
  FROM "ApiToken"
 WHERE "revokedAt" IS NULL
 GROUP BY "orgId"
ON CONFLICT ("orgId", "period", "metric") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now();
