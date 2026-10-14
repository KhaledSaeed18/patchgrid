-- CreateTable
CREATE TABLE "ApiToken" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "membershipId" UUID NOT NULL,
    "createdByMembershipId" UUID NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "expiryWarnedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "revokedByMembershipId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiToken_orgId_createdAt_id_idx" ON "ApiToken"("orgId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ApiToken_orgId_revokedAt_expiresAt_idx" ON "ApiToken"("orgId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_orgId_id_key" ON "ApiToken"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_orgId_membershipId_key" ON "ApiToken"("orgId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_orgId_prefix_key" ON "ApiToken"("orgId", "prefix");

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_orgId_membershipId_fkey" FOREIGN KEY ("orgId", "membershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_orgId_createdByMembershipId_fkey" FOREIGN KEY ("orgId", "createdByMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_orgId_revokedByMembershipId_fkey" FOREIGN KEY ("orgId", "revokedByMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At least one scope, and only scopes the catalog knows (ADR-0021, RBAC.md §10).
ALTER TABLE "ApiToken" ALTER COLUMN "scopes" SET NOT NULL;
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_scopes_check"
  CHECK (cardinality("scopes") >= 1 AND "scopes" <@ ARRAY[
    'tickets:read', 'tickets:write', 'comments:internal', 'assets:read', 'assets:write', 'kb:read', 'webhooks:write'
  ]::text[]);
-- Revoked by someone, at some time, or neither (ADR-0042).
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_revocation_check"
  CHECK (("revokedAt" IS NULL) = ("revokedByMembershipId" IS NULL));

ALTER TABLE "ApiToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ApiToken"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
