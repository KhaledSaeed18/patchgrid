import { BullModule } from "@nestjs/bullmq"
import { Global, Module } from "@nestjs/common"

import { UsageCounterRepository } from "./repositories/usage-counter.repository"
import { UsageSourceRepository } from "./repositories/usage-source.repository"
import { QuotaService } from "./quota.service"
import { UsageReconcileProcessor, UsageReconcileService } from "./usage-reconcile"

/**
 * Plan limits, consumed inside the transaction of whatever they count, and
 * recounted nightly from their rows. Global: every creating module needs it.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: "usage-reconcile" })],
  providers: [UsageCounterRepository, QuotaService, UsageSourceRepository, UsageReconcileService, UsageReconcileProcessor],
  exports: [QuotaService],
})
export class QuotaModule {}
