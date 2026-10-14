-- CreateEnum
CREATE TYPE "MfaFactorKind" AS ENUM ('TOTP');

-- AlterTable
ALTER TABLE "PlatformAdmin" ADD COLUMN     "revokedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "UserMfaFactor" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "MfaFactorKind" NOT NULL DEFAULT 'TOTP',
    "secretEncrypted" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "lastUsedStep" INTEGER,
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMfaFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMfaRecovery" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMfaRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAuditLog" (
    "id" UUID NOT NULL,
    "platformAdminId" UUID,
    "action" TEXT NOT NULL,
    "targetOrgId" UUID,
    "targetUserId" UUID,
    "diff" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserMfaFactor_userId_idx" ON "UserMfaFactor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserMfaFactor_one_confirmed" ON "UserMfaFactor"("userId", "kind") WHERE ("confirmedAt" IS NOT NULL);

-- CreateIndex
CREATE INDEX "UserMfaRecovery_userId_idx" ON "UserMfaRecovery"("userId");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_createdAt_id_idx" ON "PlatformAuditLog"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "PlatformAuditLog_platformAdminId_createdAt_idx" ON "PlatformAuditLog"("platformAdminId", "createdAt");

-- AddForeignKey
ALTER TABLE "UserMfaFactor" ADD CONSTRAINT "UserMfaFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMfaRecovery" ADD CONSTRAINT "UserMfaRecovery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAuditLog" ADD CONSTRAINT "PlatformAuditLog_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A recovery code is shown once and used once; a step is a 30-second TOTP window count.
ALTER TABLE "UserMfaFactor" ADD CONSTRAINT "UserMfaFactor_step_check" CHECK ("lastUsedStep" IS NULL OR "lastUsedStep" >= 0);
