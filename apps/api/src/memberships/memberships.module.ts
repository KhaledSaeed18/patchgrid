import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { MailModule } from "../mail/mail.module"
import { PlatformModule } from "../platform/platform.module"
import { TeamsModule } from "../teams/teams.module"
import { InvitationAcceptanceService } from "./acceptance/invitation-acceptance.service"
import { InvitationsController } from "./invitations/invitations.controller"
import { InvitationsService } from "./invitations/invitations.service"
import { MeController } from "./me.controller"
import { SupportModule } from "../support/support.module"
import { MeService } from "./me.service"
import { MembersController } from "./members.controller"
import { MembershipRepositoryModule } from "./membership-repository.module"
import { MembersService } from "./members.service"
import { ProjectionReconcileProcessor, ProjectionReconcileService } from "./projections/projection-reconcile"
import { ProjectionSourceRepository } from "./projections/projection-source.repository"
import { InvitationRepository } from "./repositories/invitation.repository"

/**
 * Members and invitations (ADR-0033). The membership repository itself lives
 * in `MembershipRepositoryModule`, because the auth guard needs it and these
 * services need the auth module — the split keeps that dependency one-way.
 */
@Module({
  imports: [
    SupportModule,
    AuthModule,
    PlatformModule,
    MailModule,
    MembershipRepositoryModule,
    TeamsModule,
    BullModule.registerQueue({ name: "projection-reconcile" }),
  ],
  controllers: [MeController, MembersController, InvitationsController],
  providers: [
    InvitationRepository,
    MeService,
    MembersService,
    InvitationsService,
    InvitationAcceptanceService,
    ProjectionSourceRepository,
    ProjectionReconcileService,
    ProjectionReconcileProcessor,
  ],
})
export class MembershipsModule {}
