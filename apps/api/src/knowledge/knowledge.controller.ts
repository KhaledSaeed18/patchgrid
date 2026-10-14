import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common"
import {
  type Article,
  articleListQuerySchema,
  type ArticlePage,
  articleSearchQuerySchema,
  type ArticleSearchResult,
  articleSlugSchema,
  createArticleRequestSchema,
  idSchema,
  updateArticleRequestSchema,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { Idempotent } from "../common/idempotency/idempotency"
import { KnowledgeService } from "./knowledge.service"

class ArticleParamsDto extends createZodDto(z.object({ id: idSchema })) {}
class SlugParamsDto extends createZodDto(z.object({ slug: articleSlugSchema })) {}
class ListDto extends createZodDto(articleListQuerySchema) {}
class SearchDto extends createZodDto(articleSearchQuerySchema) {}
class CreateDto extends createZodDto(createArticleRequestSchema) {}
class UpdateDto extends createZodDto(updateArticleRequestSchema) {}

/**
 * The knowledge base (DOMAIN.md §9.2). Every member holds
 * `kb:read_published`, so reads pass the route's filter; which articles
 * they see is the service's decision, by visibility. An article's page is
 * addressed by slug and counts a view; the editor loads it by id.
 */
@Controller("articles")
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  @RequirePermission("kb:read_published")
  list(@Query() query: ListDto): Promise<ArticlePage> {
    return this.knowledge.list(query)
  }

  @Get("search")
  @RequirePermission("kb:read_published")
  search(@Query() query: SearchDto): Promise<ArticleSearchResult> {
    return this.knowledge.search(query)
  }

  @Get("by-slug/:slug")
  @RequirePermission("kb:read_published")
  read(@Param() params: SlugParamsDto): Promise<Article> {
    return this.knowledge.read(params.slug)
  }

  @Get(":id")
  @RequirePermission("kb:read_published")
  get(@Param() params: ArticleParamsDto): Promise<Article> {
    return this.knowledge.get(params.id)
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("kb:write")
  @Idempotent()
  create(@Body() body: CreateDto): Promise<Article> {
    return this.knowledge.create(body)
  }

  @Patch(":id")
  @RequirePermission("kb:write")
  update(@Param() params: ArticleParamsDto, @Body() body: UpdateDto): Promise<Article> {
    return this.knowledge.update(params.id, body)
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("kb:delete")
  async remove(@Param() params: ArticleParamsDto): Promise<void> {
    await this.knowledge.remove(params.id)
  }
}
