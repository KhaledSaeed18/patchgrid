import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { PlatformModule } from "../platform/platform.module"
import { OrgsController } from "./orgs.controller"
import { ProvisioningService } from "./provisioning/provisioning.service"
import { OrganizationProvisioningRepository } from "./repositories/organization-provisioning.repository"

/** Organizations: creation now; settings, slug change and domain verification with their M1 items. */
@Module({
  imports: [PlatformModule, AuthModule],
  controllers: [OrgsController],
  providers: [OrganizationProvisioningRepository, ProvisioningService],
})
export class OrgsModule {}
