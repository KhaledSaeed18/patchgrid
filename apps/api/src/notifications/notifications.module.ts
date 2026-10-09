import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { NotificationsController } from "./notifications.controller"
import { NotificationsService } from "./notifications.service"
import { NotificationRepository } from "./repositories/notification.repository"

/** In-app notifications (M3): the inbox, the fan-out that fills it, the stream that announces it. */
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationRepository, NotificationsService],
  exports: [NotificationRepository],
})
export class NotificationsModule {}
