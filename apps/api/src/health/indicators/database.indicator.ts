import { Injectable } from "@nestjs/common"
import { HealthIndicatorService, type HealthIndicatorResult } from "@nestjs/terminus"

import { PrismaService } from "../../prisma/prisma.service"

@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly prisma: PrismaService,
  ) {}

  async check(key = "database"): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key)
    const startedAt = Date.now()
    try {
      await this.prisma.ping()
      return indicator.up({ latencyMs: Date.now() - startedAt })
    } catch (error) {
      return indicator.down({
        // Readiness output is operator-facing, not public: `/health/ready` is not
        // a route we expose to the internet. Still ids and messages only.
        message: error instanceof Error ? error.message : "unreachable",
      })
    }
  }
}
