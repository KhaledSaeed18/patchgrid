import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { MailModule } from "../mail/mail.module"
import { PlatformModule } from "../platform/platform.module"
import { TeamRepository } from "../teams/repositories/team.repository"
import { InvitationAcceptanceService } from "./acceptance/invitation-acceptance.service"
import { InvitationsController } from "./invitations/invitations.controller"
import { InvitationsService } from "./invitations/invitations.service"
import { MembersController } from "./members.controller"
import { MembershipRepositoryModule } from "./membership-repository.module"
import { MembersService } from "./members.service"
import { InvitationRepository } from "./repositories/invitation.repository"

/**
 * Members and invitations (ADR-0033). The membership repository itself lives
 * in `MembershipRepositoryModule`, because the auth guard needs it and these
 * services need the auth module — the split keeps that dependency one-way.
 */
@Module({
  imports: [AuthModule, PlatformModule, MailModule, MembershipRepositoryModule],
  controllers: [MembersController, InvitationsController],
  providers: [InvitationRepository, TeamRepository, MembersService, InvitationsService, InvitationAcceptanceService],
})
export class MembershipsModule {}
