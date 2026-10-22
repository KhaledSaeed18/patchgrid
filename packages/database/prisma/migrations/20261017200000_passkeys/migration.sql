-- CreateTable
CREATE TABLE "UserPasskey" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "credentialId" BYTEA NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "signCount" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "aaguid" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),

    CONSTRAINT "UserPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPasskey_credentialId_key" ON "UserPasskey"("credentialId");

-- CreateIndex
CREATE INDEX "UserPasskey_userId_idx" ON "UserPasskey"("userId");

-- AddForeignKey
ALTER TABLE "UserPasskey" ADD CONSTRAINT "UserPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A counter never goes below zero, and a label is never blank.
ALTER TABLE "UserPasskey" ADD CONSTRAINT "UserPasskey_signCount_check" CHECK ("signCount" >= 0);
ALTER TABLE "UserPasskey" ADD CONSTRAINT "UserPasskey_label_check" CHECK (length(btrim("label")) > 0);
