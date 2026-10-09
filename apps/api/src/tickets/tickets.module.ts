import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { CategoriesModule } from "../categories/categories.module"
import { MembershipRepositoryModule } from "../memberships/membership-repository.module"
import { SlaModule } from "../sla/sla.module"
import { TeamsModule } from "../teams/teams.module"
import { CommentsService } from "./comments.service"
import { CommentRepository } from "./repositories/comment.repository"
import { TicketRepository } from "./repositories/ticket.repository"
import { WatcherRepository } from "./repositories/watcher.repository"
import { AutoCloseProcessor, AutoCloseService } from "./sweeps/auto-close"
import { SlaScanProcessor, SlaScanService } from "./sweeps/sla-scan"
import { TicketAccess } from "./ticket-access"
import { TicketAuditService } from "./ticket-audit.service"
import { TicketsController } from "./tickets.controller"
import { TicketsService } from "./tickets.service"
import { WatchersService } from "./watchers.service"

/** The incident lifecycle (M2): tickets, their thread, their watchers, their trail — and their sweeps (M3). */
@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({ name: "auto-close" }, { name: "sla-scan" }),
    CategoriesModule,
    MembershipRepositoryModule,
    SlaModule,
    TeamsModule,
  ],
  controllers: [TicketsController],
  providers: [
    TicketRepository,
    CommentRepository,
    WatcherRepository,
    TicketAccess,
    TicketsService,
    CommentsService,
    WatchersService,
    TicketAuditService,
    AutoCloseService,
    AutoCloseProcessor,
    SlaScanService,
    SlaScanProcessor,
  ],
})
export class TicketsModule {}
