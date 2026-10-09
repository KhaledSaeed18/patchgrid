import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { NotificationsController } from "./notifications.controller"
import { NotificationsService } from "./notifications.service"
import { NOTIFY_QUEUE, Notifier, NotifyProcessor, NotifyService } from "./notify"
import { NotificationRepository } from "./repositories/notification.repository"
import { TicketCircleRepository } from "./repositories/ticket-circle.repository"

/** In-app notifications (M3): the inbox, the fan-out that fills it, the stream that announces it. */
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: NOTIFY_QUEUE })],
  controllers: [NotificationsController],
  providers: [NotificationRepository, TicketCircleRepository, NotificationsService, Notifier, NotifyService, NotifyProcessor],
  exports: [Notifier],
})
export class NotificationsModule {}
