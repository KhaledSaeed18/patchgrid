import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { MembershipRepositoryModule } from "../memberships/membership-repository.module"
import { AssetsController } from "./assets.controller"
import { AssetsService } from "./assets.service"
import { AssetRepository } from "./repositories/asset.repository"

/** The CMDB (M5): assets, and the links tickets make to them. */
@Module({
  imports: [AuthModule, MembershipRepositoryModule],
  controllers: [AssetsController],
  providers: [AssetRepository, AssetsService],
  exports: [AssetRepository, AssetsService],
})
export class AssetsModule {}
