import { Injectable } from "@nestjs/common"
import { HealthIndicatorService, type HealthIndicatorResult } from "@nestjs/terminus"

import { RedisService } from "../../redis/redis.service"

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly redis: RedisService,
  ) {}

  async check(key = "redis"): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key)
    const startedAt = Date.now()
    try {
      const reply = await this.redis.ping()
      if (reply !== "PONG") return indicator.down({ message: `unexpected reply: ${reply}` })
      return indicator.up({ latencyMs: Date.now() - startedAt })
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : "unreachable",
      })
    }
  }
}
