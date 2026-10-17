import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common"
import {
  type CreatedWebhookEndpoint,
  createWebhookEndpointRequestSchema,
  idSchema,
  type Page,
  updateWebhookEndpointRequestSchema,
  type WebhookDelivery,
  webhookDeliveryListQuerySchema,
  type WebhookEndpoint,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { WebhooksService } from "./webhooks.service"

class EndpointParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class DeliveryParamsDto extends createZodDto(z.object({ id: idSchema, deliveryId: idSchema })) {}
class CreateEndpointDto extends createZodDto(createWebhookEndpointRequestSchema) {}
class UpdateEndpointDto extends createZodDto(updateWebhookEndpointRequestSchema) {}
class DeliveryListQueryDto extends createZodDto(webhookDeliveryListQuerySchema) {}

/** `/org/webhooks` — outbound webhooks (ADR-0050). */
@Controller("org/webhooks")
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  @RequirePermission("webhook:manage")
  list(): Promise<WebhookEndpoint[]> {
    return this.webhooks.list()
  }

  /**
   * Not `@Idempotent`, as with API tokens (ADR-0042): a replayable answer would
   * be the secret, stored in Redis. A retried create makes a second endpoint,
   * which the list shows and an admin can remove.
   */
  @Post()
  @RequirePermission("webhook:manage")
  create(@Body() body: CreateEndpointDto): Promise<CreatedWebhookEndpoint> {
    return this.webhooks.create(body)
  }

  @Get(":id")
  @RequirePermission("webhook:manage")
  get(@Param() params: EndpointParamsDto): Promise<WebhookEndpoint> {
    return this.webhooks.get(params.id)
  }

  @Patch(":id")
  @RequirePermission("webhook:manage")
  update(@Param() params: EndpointParamsDto, @Body() body: UpdateEndpointDto): Promise<WebhookEndpoint> {
    return this.webhooks.update(params.id, body)
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("webhook:manage")
  async remove(@Param() params: EndpointParamsDto): Promise<void> {
    await this.webhooks.remove(params.id)
  }

  @Post(":id/rotate-secret")
  @HttpCode(200)
  @RequirePermission("webhook:manage")
  rotate(@Param() params: EndpointParamsDto): Promise<{ secret: string }> {
    return this.webhooks.rotate(params.id)
  }

  @Get(":id/deliveries")
  @RequirePermission("webhook:manage")
  deliveries(@Param() params: EndpointParamsDto, @Query() query: DeliveryListQueryDto): Promise<Page<WebhookDelivery>> {
    return this.webhooks.deliveries(params.id, query)
  }

  @Post(":id/deliveries/replay")
  @HttpCode(200)
  @RequirePermission("webhook:manage")
  replayDead(@Param() params: EndpointParamsDto): Promise<{ replayed: number }> {
    return this.webhooks.replay(params.id, null)
  }

  @Post(":id/deliveries/:deliveryId/replay")
  @HttpCode(200)
  @RequirePermission("webhook:manage")
  replay(@Param() params: DeliveryParamsDto): Promise<{ replayed: number }> {
    return this.webhooks.replay(params.id, params.deliveryId)
  }
}
