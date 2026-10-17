import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { SavedViewRepository } from "./repositories/saved-view.repository"
import { SavedViewsController } from "./saved-views.controller"
import { SavedViewsService } from "./saved-views.service"

/** Saved views (ADR-0052). */
@Module({
  imports: [AuthModule],
  controllers: [SavedViewsController],
  providers: [SavedViewRepository, SavedViewsService],
})
export class ViewsModule {}
