-- The workspace takes mail from people outside it only when it opts in.
ALTER TABLE "Organization" ADD COLUMN "allowExternalRequesters" BOOLEAN NOT NULL DEFAULT false;

-- An external requester has no account: the address they wrote from is the
-- contact, lower-cased, and only theirs.
ALTER TABLE "Membership" ADD COLUMN "contactEmail" TEXT;

-- Hand-written below this line (ENGINEERING.md §Schema changes).

-- A contact address exactly when the membership is external, and only ever a
-- requester: an outside address never holds a seat or a permission beyond its
-- own tickets. `Membership_kind_user_check` already keeps userId null for it.
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_external_contact_check"
  CHECK ((("kind" = 'EXTERNAL') = ("contactEmail" IS NOT NULL)) AND ("kind" <> 'EXTERNAL' OR "role" = 'REQUESTER'));
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_contactEmail_lowercase_check"
  CHECK ("contactEmail" IS NULL OR "contactEmail" = lower("contactEmail"));

-- One external membership per address per workspace: a second message finds the first.
CREATE UNIQUE INDEX "Membership_orgId_contactEmail_key" ON "Membership" ("orgId", "contactEmail") WHERE "kind" = 'EXTERNAL';
