import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { TeamsModule } from "../teams/teams.module"
import { CategoriesController } from "./categories.controller"
import { CategoriesService } from "./categories.service"
import { CategoryRepository } from "./repositories/category.repository"

@Module({
  imports: [AuthModule, TeamsModule],
  controllers: [CategoriesController],
  providers: [CategoryRepository, CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
