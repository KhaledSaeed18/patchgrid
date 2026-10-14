import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AttachmentsModule } from "../attachments/attachments.module"
import { AuthModule } from "../auth/auth.module"
import { MembershipRepositoryModule } from "../memberships/membership-repository.module"
import { TicketsModule } from "../tickets/tickets.module"
import { InboundEmailProcessor } from "./inbound-email.processor"
import { InboundIntakeService } from "./inbound-intake.service"
import { InboundLogController } from "./inbound-log.controller"
import { InboundLogService } from "./inbound-log.service"
import { INBOUND_QUEUE, InboundReceiver } from "./inbound-receiver.service"
import { InboundController } from "./inbound.controller"
import { InboundEmailRepository } from "./repositories/inbound-email.repository"

/** Email intake (M6, ADR-0027, ADR-0039): the signed webhook, the per-tenant pipeline, and the admins' log of it. */
@Module({
  imports: [AuthModule, AttachmentsModule, MembershipRepositoryModule, TicketsModule, BullModule.registerQueue({ name: INBOUND_QUEUE })],
  controllers: [InboundController, InboundLogController],
  providers: [InboundEmailRepository, InboundReceiver, InboundIntakeService, InboundEmailProcessor, InboundLogService],
})
export class InboundModule {}
