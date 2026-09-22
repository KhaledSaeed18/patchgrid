import { Injectable } from "@nestjs/common"
import { HealthIndicatorService, type HealthIndicatorResult } from "@nestjs/terminus"

import { InjectConfig, type AppConfig } from "../../config/app-config"

/**
 * Object storage reachability.
 *
 * Deliberately an unauthenticated HTTP probe rather than an S3 SDK call: at M0
 * nothing else needs the SDK, and a readiness check should not be the reason a
 * multi-megabyte dependency is in the bundle. MinIO and S3-compatible gateways
 * both serve a liveness path.
 */
@Injectable()
export class ObjectStorageHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async check(key = "object-storage"): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key)
    const url = new URL("/minio/health/live", this.config.S3_ENDPOINT)
    const startedAt = Date.now()

    try {
      // A readiness probe must never be the thing that hangs the readiness probe.
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) {
        return indicator.down({ message: `HTTP ${String(response.status)}` })
      }
      return indicator.up({ latencyMs: Date.now() - startedAt })
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : "unreachable",
      })
    }
  }
}
