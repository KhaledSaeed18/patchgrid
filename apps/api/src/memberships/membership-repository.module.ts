import { Module } from "@nestjs/common"

import { MembershipRepository } from "./repositories/membership.repository"

/**
 * The membership repository on its own, for the auth guard and the session
 * service. `MembershipsModule` imports `AuthModule` for the actor and the
 * epoch; `AuthModule` imports this, so the dependency runs one way.
 */
@Module({
  providers: [MembershipRepository],
  exports: [MembershipRepository],
})
export class MembershipRepositoryModule {}
