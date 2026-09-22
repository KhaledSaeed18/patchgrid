import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common"
import Redis from "ioredis"

import { InjectConfig, type AppConfig } from "../config/app-config"

/**
 * The shared Redis connection.
 *
 * Redis is used for queues, throttling, the tenant lookup cache, quota display
 * and the revocation epoch (ADR-0024) — never for sessions, which are stateless
 * JWTs plus that epoch (ADR-0004).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)
  readonly client: Redis

  constructor(@InjectConfig() config: AppConfig) {
    this.client = new Redis(config.REDIS_URL, {
      // Fail fast instead of queueing commands against a dead server: a request
      // that cannot reach Redis should error now, not hang until a timeout.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    })

    this.client.on("error", (error: Error) => {
      // Logged, not thrown: a transient Redis failure must not take the process
      // down. Readiness reports it, and the load balancer stops sending traffic.
      this.logger.warn(`redis: ${error.message}`)
    })
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect()
  }

  async ping(): Promise<string> {
    if (this.client.status !== "ready") await this.client.connect()
    return this.client.ping()
  }
}
