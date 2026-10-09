import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { PlatformModule } from "../platform/platform.module"
import { OrgsController } from "./orgs.controller"
import { ProvisioningService } from "./provisioning/provisioning.service"
import { OrganizationProvisioningRepository } from "./repositories/organization-provisioning.repository"
import { OrganizationSettingsRepository } from "./repositories/organization-settings.repository"
import { SlugRegistryRepository } from "./repositories/slug-registry.repository"
import { OrgSettingsController } from "./settings/org-settings.controller"
import { OrgSettingsService } from "./settings/org-settings.service"

/** Organizations: creation, settings and slug change; domain verification arrives with its item. */
@Module({
  imports: [PlatformModule, AuthModule],
  controllers: [OrgsController, OrgSettingsController],
  providers: [
    OrganizationProvisioningRepository,
    OrganizationSettingsRepository,
    SlugRegistryRepository,
    ProvisioningService,
    OrgSettingsService,
  ],
})
export class OrgsModule {}
