import { Global, Module } from "@nestjs/common"

import { UsageCounterRepository } from "./repositories/usage-counter.repository"
import { QuotaService } from "./quota.service"

/** Plan limits, consumed inside the transaction of whatever they count. Global: every creating module needs it. */
@Global()
@Module({
  providers: [UsageCounterRepository, QuotaService],
  exports: [QuotaService],
})
export class QuotaModule {}
