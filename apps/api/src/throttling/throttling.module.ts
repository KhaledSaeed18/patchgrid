import { Module } from "@nestjs/common"
import { APP_GUARD } from "@nestjs/core"
import { ThrottlerModule } from "@nestjs/throttler"

import { RedisThrottlerStorage } from "./redis-throttler.storage"
import { IpThrottlerGuard } from "./throttler.guards"
import { THROTTLERS } from "./throttlers"

@Module({ providers: [RedisThrottlerStorage], exports: [RedisThrottlerStorage] })
export class ThrottlingStorageModule {}

/**
 * Pipeline step 3: per-IP (and per-address) limits before tenant resolution,
 * so an unauthenticated flood cannot buy the Redis and database reads that
 * resolution costs. Imported before TenancyModule, which is what puts the
 * guard first. Step 6, per org, is `OrgThrottlerGuard` in TenancyModule.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ThrottlingStorageModule],
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({ throttlers: THROTTLERS, storage }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: IpThrottlerGuard }],
})
export class ThrottlingModule {}

