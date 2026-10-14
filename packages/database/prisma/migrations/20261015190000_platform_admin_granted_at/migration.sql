-- AlterTable
ALTER TABLE "PlatformAdmin" ADD COLUMN     "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Every existing grant began when its row was made.
UPDATE "PlatformAdmin" SET "grantedAt" = "createdAt";
