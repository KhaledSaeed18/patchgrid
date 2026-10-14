-- AlterEnum
ALTER TYPE "OrganizationStatus" ADD VALUE 'DELETED';
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "deletedAt" TIMESTAMPTZ(3);
-- AlterTable
ALTER TABLE "UserOrgIndex" ADD COLUMN     "orgDeletionRequestedAt" TIMESTAMPTZ(3);
