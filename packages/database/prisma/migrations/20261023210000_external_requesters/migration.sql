-- ADR-0027 §4: a requester outside the workspace is a membership of its own
-- kind, so every row still names people by membershipId. Used by the next
-- migration, which a new enum value cannot share a transaction with.
ALTER TYPE "MembershipKind" ADD VALUE 'EXTERNAL';
