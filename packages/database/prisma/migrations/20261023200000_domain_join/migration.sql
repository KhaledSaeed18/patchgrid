-- TENANCY.md §5: verified-domain auto-join, opt-in and off by default. The two
-- columns have been in the schema since the design; the role becomes a value
-- rather than a maybe.
UPDATE "Organization" SET "defaultJoinRole" = 'REQUESTER' WHERE "defaultJoinRole" IS NULL;
ALTER TABLE "Organization" ALTER COLUMN "defaultJoinRole" SET DEFAULT 'REQUESTER';
ALTER TABLE "Organization" ALTER COLUMN "defaultJoinRole" SET NOT NULL;

-- Hand-written: a domain lets in requesters or agents, never above (the rule
-- ADR-0054 gives an identity provider's default role), and only a proved
-- domain can let anyone in.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_defaultJoinRole_check"
  CHECK ("defaultJoinRole" IN ('REQUESTER', 'AGENT'));
UPDATE "Organization" SET "allowDomainJoin" = false WHERE "allowDomainJoin" AND "domainVerifiedAt" IS NULL;
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_domainJoin_proved_check"
  CHECK (NOT "allowDomainJoin" OR "domainVerifiedAt" IS NOT NULL);
