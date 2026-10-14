import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common"
import {
  type Attachment,
  type AttachmentDownload,
  idSchema,
  presignAttachmentRequestSchema,
  type PresignedUpload,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../authz/require-permission"
import { Idempotent } from "../common/idempotency/idempotency"
import { AttachmentsService } from "./attachments.service"

class AttachmentParams extends createZodDto(z.object({ id: idSchema })) {}
class PresignDto extends createZodDto(presignAttachmentRequestSchema) {}

/**
 * Files (ADR-0005, ADR-0037): presign, upload straight to storage, complete.
 * A ticket's list lives at `GET /tickets/:id/attachments`. Each route names
 * its role-level permission; the service decides on the loaded ticket and,
 * for a file on a comment, on that comment's visibility.
 */
@Controller("attachments")
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("attachment:upload")
  @Idempotent()
  presign(@Body() body: PresignDto): Promise<PresignedUpload> {
    return this.attachments.presign(body)
  }

  @Post(":id/complete")
  @HttpCode(200)
  @RequirePermission("attachment:upload")
  complete(@Param() params: AttachmentParams): Promise<Attachment> {
    return this.attachments.complete(params.id)
  }

  @Get(":id/download")
  @RequirePermission("attachment:download")
  download(@Param() params: AttachmentParams): Promise<AttachmentDownload> {
    return this.attachments.download(params.id)
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("attachment:delete")
  async remove(@Param() params: AttachmentParams): Promise<void> {
    await this.attachments.remove(params.id)
  }
}

/** `GET /tickets/:id/attachments`, beside the ticket's other parts. */
@Controller("tickets")
export class TicketAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(":id/attachments")
  @RequirePermission("ticket:read")
  list(@Param() params: AttachmentParams): Promise<Attachment[]> {
    return this.attachments.list(params.id)
  }
}
