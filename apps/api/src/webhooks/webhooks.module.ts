import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { DeliverProcessor } from "./delivery/deliver.processor"
import { WEBHOOK_DELIVER_QUEUE } from "./delivery/deliver-job"
import { WebhookDeliverer } from "./delivery/deliverer"
import { TenantLease } from "./delivery/tenant-lease"
import { WebhookSweepProcessor, WebhookSweepService } from "./delivery/webhook-sweep"
import { WebhookRepository } from "./repositories/webhook.repository"
import { WebhookSecrets } from "./webhook-secrets"
import { WebhooksConsumer } from "./webhooks.consumer"
import { WebhooksController } from "./webhooks.controller"
import { WebhooksService } from "./webhooks.service"

/** Outbound webhooks (ADR-0050): the endpoints, the `webhooks` consumer of the log, and the delivery workers. */
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: WEBHOOK_DELIVER_QUEUE }, { name: "webhook-sweep" })],
  controllers: [WebhooksController],
  providers: [
    WebhookRepository,
    WebhookSecrets,
    WebhooksService,
    WebhooksConsumer,
    WebhookDeliverer,
    TenantLease,
    DeliverProcessor,
    WebhookSweepService,
    WebhookSweepProcessor,
  ],
})
export class WebhooksModule {}
