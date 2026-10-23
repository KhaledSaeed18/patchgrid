-- TENANCY.md §8: API tokens are a plan limit. A new enum value cannot be used
-- in the transaction that adds it, so the counters are backfilled next.
ALTER TYPE "UsageMetric" ADD VALUE 'API_TOKENS';
