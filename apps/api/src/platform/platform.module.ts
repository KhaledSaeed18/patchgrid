import { Module } from "@nestjs/common"

import { ApiTokenIndexRepository } from "./repositories/api-token-index.repository"
import { OrganizationRepository } from "./repositories/organization.repository"

/**
 * Platform-class data access: the tables that carry no tenant policy and are
 * therefore readable before a tenant is known (ADR-0022). Everything tenant-
 * owned lives in its own domain module.
 */
@Module({
  providers: [OrganizationRepository, ApiTokenIndexRepository],
  exports: [OrganizationRepository, ApiTokenIndexRepository],
})
export class PlatformModule {}
