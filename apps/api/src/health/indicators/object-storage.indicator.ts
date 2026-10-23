import { Injectable } from "@nestjs/common"
import { HealthIndicatorService, type HealthIndicatorResult } from "@nestjs/terminus"

import { StorageService } from "../../storage/storage.service"

/**
 * Object storage readiness: a `HeadBucket` through the same client and
 * credentials uploads use, so MinIO, an emulator and S3 answer it alike, and it
 * fails for a missing bucket or a revoked role as well as for an outage.
 */
@Injectable()
export class ObjectStorageHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly storage: StorageService,
  ) {}

  async check(key = "object-storage"): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key)
    const startedAt = Date.now()
    try {
      // A readiness probe must never be the thing that hangs the readiness probe.
      await this.storage.reachable(2_000)
      return indicator.up({ latencyMs: Date.now() - startedAt })
    } catch (error) {
      return indicator.down({ message: error instanceof Error ? error.name : "unreachable" })
    }
  }
}
