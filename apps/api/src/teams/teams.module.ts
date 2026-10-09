import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { MembershipRepositoryModule } from "../memberships/membership-repository.module"
import { TeamRepository } from "./repositories/team.repository"
import { TeamsController } from "./teams.controller"
import { TeamsService } from "./teams.service"

/** Teams, their members and their lead (ADR-0025). Exports the repository for invitations. */
@Module({
  imports: [AuthModule, MembershipRepositoryModule],
  controllers: [TeamsController],
  providers: [TeamRepository, TeamsService],
  exports: [TeamRepository],
})
export class TeamsModule {}
