-- M7 is dropped (ADR-0056): there are no automation rules to count, and no
-- automation to author a comment. Postgres cannot remove an enum value, so each
-- type is recreated without it. The checks that compare the column with a
-- literal are dropped first and added back after, so they are rebuilt against
-- the new type rather than the old one.

DELETE FROM "UsageCounter" WHERE "metric" = 'AUTOMATION_RULES';

ALTER TABLE "UsageCounter" DROP CONSTRAINT "UsageCounter_period_check";
ALTER TYPE "UsageMetric" RENAME TO "UsageMetric_old";
CREATE TYPE "UsageMetric" AS ENUM ('AGENT_SEATS', 'TICKETS_CREATED', 'STORAGE_BYTES', 'KB_ARTICLES', 'API_TOKENS');
ALTER TABLE "UsageCounter" ALTER COLUMN "metric" TYPE "UsageMetric" USING ("metric"::text::"UsageMetric");
DROP TYPE "UsageMetric_old";
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_period_check" CHECK (
  CASE "metric" WHEN 'TICKETS_CREATED' THEN "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' ELSE "period" = 'current' END
);

-- No comment was ever written by an automation; the cast fails loudly if one was.
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_author_check";
ALTER TYPE "CommentAuthorKind" RENAME TO "CommentAuthorKind_old";
CREATE TYPE "CommentAuthorKind" AS ENUM ('MEMBER', 'SERVICE', 'SYSTEM');
ALTER TABLE "Comment" ALTER COLUMN "authorKind" TYPE "CommentAuthorKind" USING ("authorKind"::text::"CommentAuthorKind");
DROP TYPE "CommentAuthorKind_old";
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_author_check"
  CHECK ("authorKind" <> 'MEMBER' OR "authorMembershipId" IS NOT NULL);
