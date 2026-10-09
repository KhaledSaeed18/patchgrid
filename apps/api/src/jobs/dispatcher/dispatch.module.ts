import { BullModule } from "@nestjs/bullmq"
import { Module } from "@nestjs/common"

import { SWEEP_NAMES } from "../sweeps"
import { DispatchRepository } from "./repositories/dispatch.repository"
import { TENANT_DISPATCH_QUEUE, TenantDispatchProcessor, TenantDispatchService } from "./tenant-dispatch"

/**
 * The dispatcher and the sweep queues it feeds. The sweeps' processors live
 * with the modules that own their work (tickets, SLA) and register the same
 * queue names.
 */
@Module({
  imports: [BullModule.registerQueue({ name: TENANT_DISPATCH_QUEUE }, ...SWEEP_NAMES.map((name) => ({ name })))],
  providers: [DispatchRepository, TenantDispatchService, TenantDispatchProcessor],
  exports: [TenantDispatchService],
})
export class DispatchModule {}
