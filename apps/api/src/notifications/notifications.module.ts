import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { MailModule } from "../mail/mail.module"
import { TicketAudience } from "./audience"
import { NotificationStreamService } from "./live/notification-stream.service"
import { StreamBus } from "./live/stream-bus"
import { TicketPulse } from "./live/ticket-pulse"
import { NotificationsController } from "./notifications.controller"
import { NotificationsService } from "./notifications.service"
import { Notifier, NotifyConsumer, NotifyService } from "./notify"
import { NotificationPreferencesRepository } from "./repositories/notification-preferences.repository"
import { NotificationRepository } from "./repositories/notification.repository"
import { TicketCircleRepository } from "./repositories/ticket-circle.repository"
import { TicketFactsRepository } from "./repositories/ticket-facts.repository"

/** Notifications (M3): the inbox, the fan-out that fills it and emails, the stream that announces it. */
@Module({
  imports: [AuthModule, MailModule],
  controllers: [NotificationsController],
  providers: [
    TicketAudience,
    NotificationRepository,
    NotificationPreferencesRepository,
    TicketCircleRepository,
    TicketFactsRepository,
    NotificationsService,
    Notifier,
    NotifyService,
    NotifyConsumer,
    StreamBus,
    TicketPulse,
    NotificationStreamService,
  ],
  exports: [Notifier, TicketPulse],
})
export class NotificationsModule {}
