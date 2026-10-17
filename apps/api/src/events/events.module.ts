import { BullModule } from "@nestjs/bullmq"
import { Global, Module } from "@nestjs/common"

import { DispatchModule } from "../jobs/dispatcher/dispatch.module"
import { EventConsumers } from "./consumer"
import { DrainProcessor } from "./drain.processor"
import { DrainRequests, OUTBOX_DRAIN_QUEUE } from "./drain-requests"
import { Outbox } from "./outbox"
import { OutboxListener } from "./outbox-listener"
import { OutboxSweepProcessor, OutboxSweepService } from "./outbox-sweep"
import { EventRelay } from "./relay"
import { OutboxRepository } from "./repositories/outbox.repository"

/**
 * The transactional outbox and its relay (ADR-0049). Global, because every
 * module that changes a ticket appends to it, and consumers register here
 * from the modules that own them.
 */
@Global()
@Module({
  imports: [DispatchModule, BullModule.registerQueue({ name: OUTBOX_DRAIN_QUEUE }, { name: "outbox-sweep" })],
  providers: [
    OutboxRepository,
    Outbox,
    EventConsumers,
    EventRelay,
    DrainRequests,
    DrainProcessor,
    OutboxListener,
    OutboxSweepService,
    OutboxSweepProcessor,
  ],
  exports: [Outbox, EventConsumers, EventRelay, DrainRequests],
})
export class EventsModule {}
