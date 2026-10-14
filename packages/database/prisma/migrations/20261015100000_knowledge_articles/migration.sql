-- CreateEnum
CREATE TYPE "ArticleVisibility" AS ENUM ('DRAFT', 'INTERNAL', 'PUBLISHED');

-- CreateTable
CREATE TABLE "KnowledgeArticle" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "categoryId" UUID,
    "authorMembershipId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "visibility" "ArticleVisibility" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    -- Hand-edited: GENERATED ALWAYS, which Prisma cannot declare (DOMAIN.md §9.1).
    "searchVector" tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
      setweight(to_tsvector('english', coalesce("body", '')), 'B')
    ) STORED,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "KnowledgeArticle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeArticle_orgId_updatedAt_id_idx" ON "KnowledgeArticle"("orgId", "updatedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "KnowledgeArticle_orgId_authorMembershipId_idx" ON "KnowledgeArticle"("orgId", "authorMembershipId");

-- CreateIndex
CREATE INDEX "KnowledgeArticle_orgId_categoryId_idx" ON "KnowledgeArticle"("orgId", "categoryId");

-- CreateIndex
CREATE INDEX "KnowledgeArticle_searchVector_idx" ON "KnowledgeArticle" USING GIN ("searchVector");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeArticle_orgId_id_key" ON "KnowledgeArticle"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeArticle_orgId_slug_key" ON "KnowledgeArticle"("orgId", "slug");

-- AddForeignKey
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_orgId_categoryId_fkey" FOREIGN KEY ("orgId", "categoryId") REFERENCES "Category"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_orgId_authorMembershipId_fkey" FOREIGN KEY ("orgId", "authorMembershipId") REFERENCES "Membership"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A version that only climbs; a count that cannot go negative; an address the app can route.
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_version_check" CHECK ("version" > 0);
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_viewCount_check" CHECK ("viewCount" >= 0);
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_slug_check"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") <= 80);
-- Published since: set exactly while PUBLISHED (DOMAIN.md §9.2).
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_publishedAt_check"
  CHECK (("visibility" = 'PUBLISHED') = ("publishedAt" IS NOT NULL));

ALTER TABLE "KnowledgeArticle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeArticle" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "KnowledgeArticle"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
