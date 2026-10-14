import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from "@nestjs/common"
import {
  idSchema,
  notificationListQuerySchema,
  type NotificationPage,
  type NotificationPreferences,
  updateNotificationPreferencesSchema,
} from "@patchgrid/contracts"
import type { Request, Response } from "express"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { writeEventStream } from "../common/http/sse"
import { NotificationStreamService } from "./live/notification-stream.service"
import { NotificationsService } from "./notifications.service"

class ListDto extends createZodDto(notificationListQuerySchema) {}
class ParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class PreferencesDto extends createZodDto(updateNotificationPreferencesSchema) {}

/** The caller's own inbox (DOMAIN.md §8), and the live stream beside it (ADR-0008). */
@Controller("notifications")
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly streams: NotificationStreamService,
  ) {}

  @Get()
  @RequirePermission("notification:read")
  list(@Query() query: ListDto): Promise<NotificationPage> {
    return this.notifications.list(query)
  }

  /** `Last-Event-ID` is the last notification's id; a reconnect replays what came after it. */
  @Get("stream")
  @RequirePermission("notification:read")
  async stream(@Req() request: Request, @Res() response: Response): Promise<void> {
    writeEventStream(response, await this.streams.open(request.header("last-event-id")))
  }

  @Get("preferences")
  @RequirePermission("notification:read")
  readPreferences(): Promise<NotificationPreferences> {
    return this.notifications.readPreferences()
  }

  @Patch("preferences")
  @RequirePermission("notification:update")
  updatePreferences(@Body() body: PreferencesDto): Promise<NotificationPreferences> {
    return this.notifications.updatePreferences(body)
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
