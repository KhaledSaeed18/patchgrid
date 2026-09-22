import { Controller, Get } from "@nestjs/common"
import { HealthCheck, HealthCheckService, type HealthCheckResult } from "@nestjs/terminus"

import { Public } from "../common/decorators/route-markers"
import { DatabaseHealthIndicator } from "./indicators/database.indicator"
import { ObjectStorageHealthIndicator } from "./indicators/object-storage.indicator"
import { RedisHealthIndicator } from "./indicators/redis.indicator"

/**
 * Health endpoints, served outside the `/api/v1` prefix so orchestrators can
 * find them where they expect to.
 *
 * The distinction is the whole point:
 *
 * - **liveness** answers "is this process wedged?" and touches nothing external.
 *   A dependency being down must never restart the process — that turns one
 *   outage into a crash loop.
 * - **readiness** answers "should traffic come here?" and checks everything a
 *   request needs. Failing it removes the instance from rotation and leaves it
 *   running, which is what you want.
 */
@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly objectStorage: ObjectStorageHealthIndicator,
  ) {}

  @Get()
  @Public()
  liveness(): { status: "ok" } {
    return { status: "ok" }
  }

  @Get("ready")
  @Public()
  @HealthCheck()
  async readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.check(),
      () => this.redis.check(),
      () => this.objectStorage.check(),
    ])
  }
}
