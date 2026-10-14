import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module"
import { CategoriesModule } from "../categories/categories.module"
import { KnowledgeController } from "./knowledge.controller"
import { KnowledgeService } from "./knowledge.service"
import { ArticleRepository } from "./repositories/article.repository"

/** The knowledge base (M5): articles by visibility, searched per org. */
@Module({
  imports: [AuthModule, CategoriesModule],
  controllers: [KnowledgeController],
  providers: [ArticleRepository, KnowledgeService],
})
export class KnowledgeModule {}
