import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common"
import {
  type AuditEntry,
  assignTicketRequestSchema,
  type Comment,
  commentInputSchema,
  createTicketRequestSchema,
  editCommentRequestSchema,
  idSchema,
  type Ticket,
  ticketListQuerySchema,
  type TicketPage,
  transitionRequestSchema,
  updateTicketRequestSchema,
  type Watcher,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { CommentsService } from "./comments.service"
import { TicketAuditService } from "./ticket-audit.service"
import { TicketsService } from "./tickets.service"
import { WatchersService } from "./watchers.service"

class TicketParams extends createZodDto(z.object({ id: idSchema })) {}
class CommentParams extends createZodDto(z.object({ id: idSchema, commentId: idSchema })) {}
class WatcherParams extends createZodDto(z.object({ id: idSchema, membershipId: idSchema })) {}
class ListDto extends createZodDto(ticketListQuerySchema) {}
class CreateDto extends createZodDto(createTicketRequestSchema) {}
class UpdateDto extends createZodDto(updateTicketRequestSchema) {}
class AssignDto extends createZodDto(assignTicketRequestSchema) {}
class TransitionDto extends createZodDto(transitionRequestSchema) {}
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
    private readonly audit: TicketAuditService,
  ) {}

  @Get()
  @RequirePermission("ticket:read")
  list(@Query() query: ListDto): Promise<TicketPage> {
    return this.tickets.list(query)
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("ticket:create")
  create(@Body() body: CreateDto): Promise<Ticket> {
    return this.tickets.create(body)
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

  @Get(":id/audit")
  @RequirePermission("ticket:read_audit")
  auditTrail(@Param() params: TicketParams): Promise<AuditEntry[]> {
    return this.audit.trail(params.id)
  }
}
