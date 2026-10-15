-- ADR-0045: an owner may require a second factor of every member. Off for every
-- existing workspace; turning it on gates the next sign-in, not open sessions.
ALTER TABLE "Organization" ADD COLUMN     "requireMfa" BOOLEAN NOT NULL DEFAULT false;
