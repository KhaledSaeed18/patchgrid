import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AssetsModule } from "../assets/assets.module"
import { AuthModule } from "../auth/auth.module"
import { CategoriesModule } from "../categories/categories.module"
import { MembershipRepositoryModule } from "../memberships/membership-repository.module"
import { NotificationsModule } from "../notifications/notifications.module"
import { SlaModule } from "../sla/sla.module"
import { TeamsModule } from "../teams/teams.module"
import { CommentsService } from "./comments.service"
import { LinksService } from "./links.service"
import { CommentRepository } from "./repositories/comment.repository"
import { LinkRepository } from "./repositories/link.repository"
import { TicketRepository } from "./repositories/ticket.repository"
import { WatcherRepository } from "./repositories/watcher.repository"
import { AutoCloseProcessor, AutoCloseService } from "./sweeps/auto-close"
import { SlaScanProcessor, SlaScanService } from "./sweeps/sla-scan"
import { TicketAccess } from "./ticket-access"
import { TicketAssetsService } from "./ticket-assets.service"
import { TicketAuditService } from "./ticket-audit.service"
import { TicketsController } from "./tickets.controller"
import { TicketsService } from "./tickets.service"
import { WatchersService } from "./watchers.service"

/** Tickets of every type: their thread, watchers, links, assets and trail (M2, M4, M5) — and their sweeps (M3). */
@Module({
  imports: [
    AssetsModule,
    AuthModule,
    BullModule.registerQueue({ name: "auto-close" }, { name: "sla-scan" }),
    CategoriesModule,
    MembershipRepositoryModule,
    NotificationsModule,
    SlaModule,
    TeamsModule,
  ],
  controllers: [TicketsController],
  providers: [
    TicketRepository,
    CommentRepository,
    LinkRepository,
    WatcherRepository,
    TicketAccess,
    TicketsService,
    CommentsService,
    WatchersService,
    LinksService,
    TicketAssetsService,
    TicketAuditService,
    AutoCloseService,
    AutoCloseProcessor,
    SlaScanService,
    SlaScanProcessor,
  ],
  exports: [TicketAccess, CommentRepository, TicketRepository],
})
export class TicketsModule {}
