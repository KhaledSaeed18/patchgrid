-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "txn" BIGINT NOT NULL DEFAULT ((pg_current_xact_id())::text)::bigint,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventConsumer" (
    "orgId" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "cursorTxn" BIGINT NOT NULL DEFAULT 0,
    "cursorEventId" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "failingEventId" UUID,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EventConsumer_pkey" PRIMARY KEY ("orgId","consumer")
);

-- CreateTable
CREATE TABLE "EventDeadLetter" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "eventId" UUID NOT NULL,
    "failures" INTEGER NOT NULL,
    "error" TEXT NOT NULL,
    "parkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replayedAt" TIMESTAMPTZ(3),

    CONSTRAINT "EventDeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_orgId_txn_id_idx" ON "OutboxEvent"("orgId", "txn", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_orgId_id_key" ON "OutboxEvent"("orgId", "id");

-- CreateIndex
CREATE INDEX "EventDeadLetter_orgId_consumer_parkedAt_idx" ON "EventDeadLetter"("orgId", "consumer", "parkedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "EventDeadLetter_orgId_id_key" ON "EventDeadLetter"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EventDeadLetter_orgId_consumer_eventId_key" ON "EventDeadLetter"("orgId", "consumer", "eventId");

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventConsumer" ADD CONSTRAINT "EventConsumer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDeadLetter" ADD CONSTRAINT "EventDeadLetter_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDeadLetter" ADD CONSTRAINT "EventDeadLetter_orgId_eventId_fkey" FOREIGN KEY ("orgId", "eventId") REFERENCES "OutboxEvent"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- A cursor never sits on an event it has not passed, and a failure names its event (ADR-0049).
ALTER TABLE "EventConsumer" ADD CONSTRAINT "EventConsumer_failure_check"
  CHECK (("failures" = 0) = ("failingEventId" IS NULL) AND "failures" >= 0);

-- Wake on commit (ADR-0049). Postgres delivers a notification only when the
-- transaction that sent it commits, so a rolled-back change wakes nobody; and
-- it folds identical payloads within one transaction, so a burst is one wake
-- per tenant. The payload is the org id alone: ids are not secrets, and the
-- event itself is read back under the tenant's own RLS.
CREATE FUNCTION outbox_wake() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  org uuid;
BEGIN
  FOR org IN SELECT DISTINCT "orgId" FROM inserted LOOP
    PERFORM pg_notify('patchgrid_outbox', org::text);
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION outbox_wake() FROM PUBLIC;

CREATE TRIGGER "OutboxEvent_wake"
  AFTER INSERT ON "OutboxEvent"
  REFERENCING NEW TABLE AS inserted
  FOR EACH STATEMENT EXECUTE FUNCTION outbox_wake();

ALTER TABLE "OutboxEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboxEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "OutboxEvent"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "EventConsumer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EventConsumer" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "EventConsumer"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "EventDeadLetter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EventDeadLetter" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "EventDeadLetter"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
