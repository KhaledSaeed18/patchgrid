import { Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common"
import { idSchema, notificationListQuerySchema, type NotificationPage } from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { NotificationsService } from "./notifications.service"

class ListDto extends createZodDto(notificationListQuerySchema) {}
class ParamsDto extends createZodDto(z.object({ id: idSchema })) {}

/** The caller's own inbox (DOMAIN.md §8). The live stream is ADR-0008's, beside it. */
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission("notification:read")
  list(@Query() query: ListDto): Promise<NotificationPage> {
    return this.notifications.list(query)
  }

  @Post("read-all")
  @HttpCode(204)
  @RequirePermission("notification:update")
  async markAllRead(): Promise<void> {
    await this.notifications.markAllRead()
  }

  @Post(":id/read")
  @HttpCode(204)
  @RequirePermission("notification:update")
  async markRead(@Param() params: ParamsDto): Promise<void> {
    await this.notifications.markRead(params.id)
  }
}
