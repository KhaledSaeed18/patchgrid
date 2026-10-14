import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { MailModule } from "../mail/mail.module"
import { MembershipRepositoryModule } from "../memberships/membership-repository.module"
import { PlatformModule } from "../platform/platform.module"
import { OrgsController } from "./orgs.controller"
import { OrgDeletionService } from "./provisioning/org-deletion.service"
import { ProvisioningService } from "./provisioning/provisioning.service"
import { OrganizationLifecycleRepository } from "./repositories/organization-lifecycle.repository"
import { OrganizationProvisioningRepository } from "./repositories/organization-provisioning.repository"
import { OrganizationSettingsRepository } from "./repositories/organization-settings.repository"
import { SlugRegistryRepository } from "./repositories/slug-registry.repository"
import { OrgSettingsController } from "./settings/org-settings.controller"
import { OrgSettingsService } from "./settings/org-settings.service"

/** Organizations: creation, settings, slug change and deletion; domain verification arrives with its item. */
@Module({
  imports: [PlatformModule, AuthModule, MailModule, MembershipRepositoryModule],
  controllers: [OrgsController, OrgSettingsController],
  providers: [
    OrganizationProvisioningRepository,
    OrganizationSettingsRepository,
    SlugRegistryRepository,
    ProvisioningService,
    OrgSettingsService,
    OrganizationLifecycleRepository,
    OrgDeletionService,
  ],
})
export class OrgsModule {}
