import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { TicketAudience } from "./audience"
import { NotificationStreamService } from "./live/notification-stream.service"
import { StreamBus } from "./live/stream-bus"
import { TicketPulse } from "./live/ticket-pulse"
import { NotificationsController } from "./notifications.controller"
import { NotificationsService } from "./notifications.service"
import { NOTIFY_QUEUE, Notifier, NotifyProcessor, NotifyService } from "./notify"
import { NotificationRepository } from "./repositories/notification.repository"
import { TicketCircleRepository } from "./repositories/ticket-circle.repository"
import { TicketFactsRepository } from "./repositories/ticket-facts.repository"

/** In-app notifications (M3): the inbox, the fan-out that fills it, the stream that announces it. */
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: NOTIFY_QUEUE })],
  controllers: [NotificationsController],
  providers: [
    TicketAudience,
    NotificationRepository,
    TicketCircleRepository,
    TicketFactsRepository,
    NotificationsService,
    Notifier,
    NotifyService,
    NotifyProcessor,
    StreamBus,
    TicketPulse,
    NotificationStreamService,
  ],
  exports: [Notifier, TicketPulse],
})
export class NotificationsModule {}
