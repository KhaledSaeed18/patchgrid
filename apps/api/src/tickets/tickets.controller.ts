import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common"
import {
  bulkTicketRequestSchema,
  type BulkTicketResult,
  type AuditEntry,
  assignTicketRequestSchema,
  type Comment,
  commentInputSchema,
  createLinkRequestSchema,
  createTicketRequestSchema,
  editCommentRequestSchema,
  idSchema,
  type Ticket,
  ticketListQuerySchema,
  ticketSearchQuerySchema,
  type TicketSearchResult,
  type TicketLink,
  type TicketPage,
  transitionRequestSchema,
  updateTicketRequestSchema,
  type Watcher,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { BulkTicketsService } from "./bulk.service"
import { CommentsService } from "./comments.service"
import { LinksService } from "./links.service"
import { TicketAssetsService } from "./ticket-assets.service"
import { TicketAuditService } from "./ticket-audit.service"
import { TicketsService } from "./tickets.service"
import { WatchersService } from "./watchers.service"
import { Idempotent } from "../common/idempotency/idempotency"
import { IP_THROTTLER, ORG_THROTTLER } from "../throttling/throttlers"
import { Throttle } from "@nestjs/throttler"

class TicketParams extends createZodDto(z.object({ id: idSchema })) {}
class CommentParams extends createZodDto(z.object({ id: idSchema, commentId: idSchema })) {}
class WatcherParams extends createZodDto(z.object({ id: idSchema, membershipId: idSchema })) {}
class LinkParams extends createZodDto(z.object({ id: idSchema, linkId: idSchema })) {}
class AssetParams extends createZodDto(z.object({ id: idSchema, assetId: idSchema })) {}
class LinkDto extends createZodDto(createLinkRequestSchema) {}
class ListDto extends createZodDto(ticketListQuerySchema) {}
class SearchDto extends createZodDto(ticketSearchQuerySchema) {}
class CreateDto extends createZodDto(createTicketRequestSchema) {}
class UpdateDto extends createZodDto(updateTicketRequestSchema) {}
class AssignDto extends createZodDto(assignTicketRequestSchema) {}
class TransitionDto extends createZodDto(transitionRequestSchema) {}
class BulkDto extends createZodDto(bulkTicketRequestSchema) {}
class CommentDto extends createZodDto(commentInputSchema) {}
class EditCommentDto extends createZodDto(editCommentRequestSchema) {}

/**
 * Tickets, their thread and their watchers. Each route names its role-level
 * permission as the first filter; the services decide on the loaded ticket —
 * "own, while NEW" cannot be answered from a route. Status changes only
 * through `/transitions` (ADR-0006).
 */
@Controller("tickets")
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly comments: CommentsService,
    private readonly watchers: WatchersService,
    private readonly links: LinksService,
    private readonly assets: TicketAssetsService,
    private readonly audit: TicketAuditService,
    private readonly bulkTickets: BulkTicketsService,
  ) {}

  @Get()
  @RequirePermission("ticket:read")
  list(@Query() query: ListDto): Promise<TicketPage> {
    return this.tickets.list(query)
  }

  /** Declared before `:id`, which would otherwise read `search` as an id. */
  @Get("search")
  @RequirePermission("ticket:read")
  search(@Query() query: SearchDto): Promise<TicketSearchResult> {
    return this.tickets.search(query)
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("ticket:create")
  @Idempotent()
  create(@Body() body: CreateDto): Promise<Ticket> {
    return this.tickets.create(body)
  }

  /**
   * One action over many tickets, each decided as the single action would be
   * (ADR-0052). Declared before `:id`. Not `@Idempotent`: a retry is already
   * safe, because each ticket the first run changed answers `conflict`.
   */
  @Post("bulk")
  @HttpCode(200)
  // One request is up to two hundred writes: priced as such (M12 review, THREAT-MODEL §9).
  @Throttle({ [IP_THROTTLER]: { limit: 10, ttl: 60_000 }, [ORG_THROTTLER]: { limit: 30, ttl: 60_000 } })
  @RequirePermission("ticket:bulk")
  bulk(@Body() body: BulkDto): Promise<BulkTicketResult> {
    return this.bulkTickets.run(body)
  }

  @Get(":id")
  @RequirePermission("ticket:read")
  get(@Param() params: TicketParams): Promise<Ticket> {
    return this.tickets.get(params.id)
  }

  @Patch(":id")
  @RequirePermission("ticket:update")
  update(@Param() params: TicketParams, @Body() body: UpdateDto): Promise<Ticket> {
    return this.tickets.update(params.id, body)
  }

  @Put(":id/assignment")
  @RequirePermission("ticket:assign")
  assign(@Param() params: TicketParams, @Body() body: AssignDto): Promise<Ticket> {
    return this.tickets.assign(params.id, body)
  }

  @Post(":id/transitions")
  @HttpCode(200)
  @RequirePermission("ticket:transition")
  transition(@Param() params: TicketParams, @Body() body: TransitionDto): Promise<Ticket> {
    return this.tickets.transition(params.id, body)
  }

  @Get(":id/comments")
  @RequirePermission("ticket:read")
  listComments(@Param() params: TicketParams): Promise<Comment[]> {
    return this.comments.list(params.id)
  }

  @Post(":id/comments")
  @HttpCode(201)
  @RequirePermission("comment:create_public")
  addComment(@Param() params: TicketParams, @Body() body: CommentDto): Promise<Comment> {
    return this.comments.add(params.id, body)
  }

  @Patch(":id/comments/:commentId")
  @RequirePermission("comment:update_own")
  editComment(@Param() params: CommentParams, @Body() body: EditCommentDto): Promise<Comment> {
    return this.comments.edit(params.id, params.commentId, body.body)
  }

  @Delete(":id/comments/:commentId")
  @HttpCode(204)
  @RequirePermission("comment:delete")
  async removeComment(@Param() params: CommentParams): Promise<void> {
    await this.comments.remove(params.id, params.commentId)
  }

  @Get(":id/watchers")
  @RequirePermission("ticket:read")
  listWatchers(@Param() params: TicketParams): Promise<Watcher[]> {
    return this.watchers.list(params.id)
  }

  @Put(":id/watchers/:membershipId")
  @RequirePermission("ticket:watch")
  addWatcher(@Param() params: WatcherParams): Promise<Watcher[]> {
    return this.watchers.add(params.id, params.membershipId)
  }

  @Delete(":id/watchers/:membershipId")
  @RequirePermission("ticket:watch")
  removeWatcher(@Param() params: WatcherParams): Promise<Watcher[]> {
    return this.watchers.remove(params.id, params.membershipId)
  }

  @Get(":id/links")
  @RequirePermission("ticket:read")
  listLinks(@Param() params: TicketParams): Promise<TicketLink[]> {
    return this.links.list(params.id)
  }

  @Post(":id/links")
  @HttpCode(201)
  @RequirePermission("ticket:link")
  @Idempotent()
  addLink(@Param() params: TicketParams, @Body() body: LinkDto): Promise<TicketLink[]> {
    return this.links.add(params.id, body)
  }

  @Delete(":id/links/:linkId")
  @RequirePermission("ticket:link")
  removeLink(@Param() params: LinkParams): Promise<TicketLink[]> {
    return this.links.remove(params.id, params.linkId)
  }

  /** The ticket's assets come back on the ticket itself; these answer 204. */
  @Put(":id/assets/:assetId")
  @HttpCode(204)
  @RequirePermission("ticket:link")
  async linkAsset(@Param() params: AssetParams): Promise<void> {
    await this.assets.link(params.id, params.assetId)
  }

  @Delete(":id/assets/:assetId")
  @HttpCode(204)
  @RequirePermission("ticket:link")
  async unlinkAsset(@Param() params: AssetParams): Promise<void> {
    await this.assets.unlink(params.id, params.assetId)
  }

  @Get(":id/audit")
  @RequirePermission("ticket:read_audit")
  auditTrail(@Param() params: TicketParams): Promise<AuditEntry[]> {
    return this.audit.trail(params.id)
  }
}
