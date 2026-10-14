import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { NotificationsModule } from "../notifications/notifications.module"
import { TicketsModule } from "../tickets/tickets.module"
import { AttachmentsController, TicketAttachmentsController } from "./attachments.controller"
import { AttachmentsService } from "./attachments.service"
import { AttachmentRepository } from "./repositories/attachment.repository"

/** Files on tickets (M5): presigned through storage, sniffed on completion, served from their own domain. */
@Module({
  imports: [AuthModule, NotificationsModule, TicketsModule],
  controllers: [AttachmentsController, TicketAttachmentsController],
  providers: [AttachmentRepository, AttachmentsService],
  exports: [AttachmentRepository],
})
export class AttachmentsModule {}
