-- CreateEnum
CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'DEAD');

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "eventTypes" TEXT[],
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "disabledReason" TEXT,
    "secretSealed" TEXT NOT NULL,
    "previousSecretSealed" TEXT,
    "previousSecretExpiresAt" TIMESTAMPTZ(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "circuitOpenUntil" TIMESTAMPTZ(3),
    "failingSince" TIMESTAMPTZ(3),
    "createdByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "lastAttemptAt" TIMESTAMPTZ(3),
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "lastDurationMs" INTEGER,
    "deliveredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookEndpoint_orgId_createdAt_idx" ON "WebhookEndpoint"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEndpoint_orgId_id_key" ON "WebhookEndpoint"("orgId", "id");

-- CreateIndex
CREATE INDEX "WebhookDelivery_orgId_endpointId_createdAt_id_idx" ON "WebhookDelivery"("orgId", "endpointId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "WebhookDelivery_orgId_status_nextAttemptAt_idx" ON "WebhookDelivery"("orgId", "status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_orgId_id_key" ON "WebhookDelivery"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_orgId_endpointId_eventId_key" ON "WebhookDelivery"("orgId", "endpointId", "eventId");

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_orgId_createdByMembershipId_fkey" FOREIGN KEY ("orgId", "createdByMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_orgId_endpointId_fkey" FOREIGN KEY ("orgId", "endpointId") REFERENCES "WebhookEndpoint"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_orgId_eventId_fkey" FOREIGN KEY ("orgId", "eventId") REFERENCES "OutboxEvent"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- A pending delivery knows when it is next tried; a finished one does not, and a delivered one says when (ADR-0050).
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_state_check"
  CHECK (
    ("status" = 'PENDING') = ("nextAttemptAt" IS NOT NULL)
    AND ("status" <> 'SUCCEEDED' OR "deliveredAt" IS NOT NULL)
    AND "attempts" >= 0
  );

-- An endpoint listens for something, and a disabled one says why.
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_state_check"
  CHECK (
    cardinality("eventTypes") > 0
    AND ("status" <> 'DISABLED' OR "disabledReason" IS NOT NULL)
    AND ("previousSecretSealed" IS NULL) = ("previousSecretExpiresAt" IS NULL)
  );

ALTER TABLE "WebhookEndpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEndpoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WebhookEndpoint"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "WebhookDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "WebhookDelivery"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
