import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common"
import {
  assertAppRoleCannotBypassRls,
  createPrismaClient,
  type PrismaClient,
} from "@patchgrid/database"

import { InjectConfig, type AppConfig } from "../config/app-config"

/**
 * Owns the database connection.
 *
 * Repositories are the only consumers — services never see this, and never see
 * Prisma at all (`ARCHITECTURE.md` §Layered architecture).
 *
 * The tenant client extension, transaction-local `set_config` and
 * `runAsTenant`/`runAsPlatform` land in M1 on top of this (ADR-0015, ADR-0022).
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)
  readonly client: PrismaClient

  constructor(@InjectConfig() private readonly config: AppConfig) {
    this.client = createPrismaClient({
      connectionString: config.DATABASE_URL,
      maxConnections: config.DATABASE_POOL_MAX,
    })
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect()

    // Refuse to start as a role that can ignore row-level security. A
    // misconfiguration here is not degraded service — it is every tenant able to
    // read every other tenant, silently, in whichever environment got it wrong
    // (ADR-0022).
    await assertAppRoleCannotBypassRls(this.client)

    this.logger.log(
      `connected to postgres (pool max ${String(this.config.DATABASE_POOL_MAX)}, RLS enforced)`,
    )
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect()
  }

  /** Cheap liveness probe for the readiness endpoint. */
  async ping(): Promise<void> {
    await this.client.$queryRawUnsafe("SELECT 1")
  }
}
