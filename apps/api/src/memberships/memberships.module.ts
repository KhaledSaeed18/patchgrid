import { Module } from "@nestjs/common"

import { MembershipRepository } from "./repositories/membership.repository"

/** Memberships: who is in an organization and as what. Invite, accept, disable, remove and role change land with the M1 membership item. */
@Module({
  providers: [MembershipRepository],
  exports: [MembershipRepository],
})
export class MembershipsModule {}
