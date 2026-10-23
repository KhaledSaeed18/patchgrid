-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "domainChallenge" TEXT,
ADD COLUMN     "requireSso" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "ssoOrgId" UUID;

-- CreateTable
CREATE TABLE "SsoConnection" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretSealed" TEXT NOT NULL,
    "defaultRole" "Role" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SsoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoIdentity" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "membershipId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSignInAt" TIMESTAMPTZ(3),

    CONSTRAINT "SsoIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SsoConnection_orgId_id_key" ON "SsoConnection"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SsoConnection_orgId_key" ON "SsoConnection"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "SsoIdentity_orgId_id_key" ON "SsoIdentity"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SsoIdentity_orgId_connectionId_subject_key" ON "SsoIdentity"("orgId", "connectionId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "SsoIdentity_orgId_membershipId_key" ON "SsoIdentity"("orgId", "membershipId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_ssoOrgId_fkey" FOREIGN KEY ("ssoOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoIdentity" ADD CONSTRAINT "SsoIdentity_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoIdentity" ADD CONSTRAINT "SsoIdentity_orgId_connectionId_fkey" FOREIGN KEY ("orgId", "connectionId") REFERENCES "SsoConnection"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoIdentity" ADD CONSTRAINT "SsoIdentity_orgId_membershipId_fkey" FOREIGN KEY ("orgId", "membershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Provisioning never makes an admin: whoever runs the IdP could otherwise mint one (ADR-0054).
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_defaultRole_check" CHECK ("defaultRole" IN ('REQUESTER', 'AGENT'));

ALTER TABLE "SsoConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SsoConnection" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SsoConnection"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "SsoIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SsoIdentity" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SsoIdentity"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
