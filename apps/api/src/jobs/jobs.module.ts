import { Module } from "@nestjs/common"
import { BullModule } from "@nestjs/bullmq"

import { APP_CONFIG, type AppConfig } from "../config/app-config"
import { redisConnectionOptions } from "../redis/redis-connection"

/**
 * The BullMQ root (ARCHITECTURE.md §Background jobs). Queues register in the
 * modules that own them; the tenant dispatcher and the sweeps arrive with the
 * milestones that need them. Jobs keep failed attempts around for inspection
 * and drop completed ones — a completed mail job would otherwise keep its
 * payload in Redis.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        connection: redisConnectionOptions(config.REDIS_URL),
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: "exponential", delay: 2_000 },
          removeOnComplete: true,
          removeOnFail: 500,
        },
      }),
    }),
  ],
})
export class JobsModule {}
