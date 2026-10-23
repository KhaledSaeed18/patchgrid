import { Injectable, Logger } from "@nestjs/common"
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  type Attachment,
  type AttachmentDownload,
  type AttachmentMimeType,
  COMMENT_EDIT_WINDOW_MINUTES,
  INLINE_RENDERABLE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  type PresignAttachmentRequest,
  type PresignedUpload,
} from "@patchgrid/contracts"
import { v7 as uuidv7 } from "uuid"

import { ActorService, type TenantActor } from "../auth/actor"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import type { Subject } from "../authz/subject"
import { type Clock, InjectClock } from "../common/clock/clock"
import {
  ConflictProblem,
  NotFoundProblem,
  NotPermittedProblem,
  PlanLimitProblem,
  ValidationProblem,
} from "../common/problems/problem.exception"
import { TicketPulse } from "../notifications/live/ticket-pulse"
import { PrismaService } from "../prisma/prisma.service"
import { QuotaService } from "../quota/quota.service"
import { StorageService } from "../storage/storage.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { CommentRepository } from "../tickets/repositories/comment.repository"
import { type Acting, type LoadedTicket, TicketAccess } from "../tickets/ticket-access"
import { SNIFF_BYTES, sniff } from "./domain/sniff"
import { type AttachmentRow, AttachmentRepository } from "./repositories/attachment.repository"

/** A presigned PUT lives five minutes; a download link two (ADR-0005). */
export const UPLOAD_TTL_SECONDS = 5 * 60
export const DOWNLOAD_TTL_SECONDS = 2 * 60
const WINDOW_MS = COMMENT_EDIT_WINDOW_MINUTES * 60_000

/**
 * Files on tickets and their comments (ADR-0005, ADR-0037).
 *
 * - **Presign**: the ticket must be one the actor can read and attach to; a
 *   file on an internal note needs the right to write one. The storage quota
 *   is taken now, for the declared size the upload is signed to.
 * - **Complete**: the uploader confirms; the stored size must be the signed
 *   one, and the first bytes must be what the type claims. A file that is
 *   not loses its bytes and is a 400; its row and quota wait for the sweep (ADR-0038).
 * - **Ingest**: a file that arrived by email, checked by the same rules,
 *   written by the API straight to its final key (ADR-0027 §7).
 * - **Serve**: a two-minute link on the files domain, as the sniffed type,
 *   an attachment unless it is a raster image. A file inherits its comment's
 *   visibility: one on an internal note is never listed, linked or deleted
 *   for someone who may not read internal notes.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name)

  constructor(
    private readonly attachments: AttachmentRepository,
    private readonly comments: CommentRepository,
    private readonly access: TicketAccess,
    private readonly storage: StorageService,
    private readonly quota: QuotaService,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pulse: TicketPulse,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async presign(request: PresignAttachmentRequest): Promise<PresignedUpload> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const row = await this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, request.ticketId, actor, this.visibility())
      this.permissions.assert(actor, "attachment:upload", loaded.subject)
      if (loaded.row.status === "CANCELLED" || loaded.row.status === "CLOSED") {
        throw new ConflictProblem("A closed or cancelled ticket takes no more files")
      }
      if (request.commentId !== undefined) {
        const comment = await this.comments.find(orgId, request.ticketId, request.commentId)
        if (comment === null || comment.deletedAt !== null) throw new NotFoundProblem()
        if (comment.visibility === "INTERNAL") {
          this.permissions.assertVisible(actor, "comment:read_internal", loaded.subject)
          this.permissions.assert(actor, "comment:create_internal", loaded.subject)
        }
      }
      await this.quota.consume(orgId, "STORAGE_BYTES", request.sizeBytes)
      return this.attachments.create(orgId, {
        ticketId: request.ticketId,
        commentId: request.commentId ?? null,
        uploaderMembershipId: actor.membershipId,
        filename: request.filename,
        declaredMimeType: request.mimeType,
        sizeBytes: request.sizeBytes,
        storageKey: storageKey(orgId, request.ticketId, request.filename),
      })
    })
    const upload = await this.storage.presignPut(
      stagingKey(row.storageKey),
      request.mimeType,
      request.sizeBytes,
      UPLOAD_TTL_SECONDS,
      this.clock.now(),
    )
    return {
      attachment: this.toAttachment(actor, row),
      upload: { method: "PUT", url: upload.url, headers: upload.headers, expiresAt: upload.expiresAt.toISOString() },
    }
  }

  async complete(id: string): Promise<Attachment> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const row = await this.attachments.find(orgId, id)
    // Only the uploader completes an upload, and only while it is pending.
    if (row === null || row.uploaderMembershipId !== actor.membershipId) throw new NotFoundProblem()
    await this.access.load(orgId, row.ticketId, actor, this.visibility())
    if (row.status === "READY") return this.toAttachment(actor, row)

    // The checked bytes are the served bytes: sniffed in staging, then copied where no upload URL reaches.
    const staged = stagingKey(row.storageKey)
    const stored = await this.storage.size(staged)
    if (stored === null) throw new ConflictProblem("Nothing has been uploaded for this file yet")
    const sniffed =
      stored === row.sizeBytes ? sniff(await this.storage.readStart(staged, SNIFF_BYTES), row.declaredMimeType as AttachmentMimeType) : null
    if (sniffed === null) {
      // Refused bytes go; the row and its quota stay PENDING until the sweep, when the upload URL is long dead.
      await this.removeObject(staged)
      throw new ValidationProblem([
        {
          path: "file",
          message: stored === row.sizeBytes ? `is not a ${row.declaredMimeType} file` : "is not the size that was declared",
          code: "rejected_upload",
        },
      ])
    }
    await this.storage.copy(staged, row.storageKey)
    await this.removeObject(staged)

    const now = this.clock.now()
    await this.prisma.transaction(async () => {
      if (!(await this.attachments.markReady(orgId, id, sniffed, now))) {
        // The sweep took the row between the copy and now: the copy is ours to remove, or nothing ever would.
        await this.removeObject(row.storageKey)
        throw new NotFoundProblem()
      }
      await this.audit.record(orgId, [
        {
          action: "ATTACHMENT_ADDED",
          entityType: "Ticket",
          entityId: row.ticketId,
          diff: { attachmentId: id, filename: row.filename, sizeBytes: row.sizeBytes, internal: row.comment?.visibility === "INTERNAL" },
        },
      ])
    })
    await this.pulse.changed(orgId, row.ticketId, row.comment?.visibility === "INTERNAL" ? "internal" : "ticket")
    return this.toAttachment(actor, { ...row, status: "READY", mimeType: sniffed })
  }

  /**
   * A file that arrived with an authenticated email (ADR-0027 §7): the same
   * allow-list, size cap, byte sniffing and quota as a browser upload, and
   * the sender's own right to attach to this ticket. The API holds the bytes,
   * so there is no presign and no staging: the object is written to its
   * final key, then the row; a failed row removes the object. A refusal is a
   * reason, never a throw — the rest of the message still lands.
   */
  async ingest(
    acting: Acting,
    file: { ticketId: string; commentId: string | null; filename: string; contentType: string; bytes: Uint8Array },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { actor } = acting
    const orgId = this.tenant.requireOrgId()
    const declared = file.contentType.split(";")[0]?.trim().toLowerCase() ?? ""
    if (!(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(declared)) return { ok: false, reason: "not an allowed type" }
    if (file.bytes.length === 0) return { ok: false, reason: "empty" }
    if (file.bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "too large" }
    const sniffed = sniff(file.bytes.subarray(0, SNIFF_BYTES), declared as AttachmentMimeType)
    if (sniffed === null) return { ok: false, reason: `not a ${declared} file` }
    const filename = file.filename.trim().slice(0, 255) || "attachment"

    const key = storageKey(orgId, file.ticketId, filename)
    await this.storage.put(key, file.bytes, sniffed)
    try {
      await this.prisma.transaction(async () => {
        const loaded = await this.access.load(orgId, file.ticketId, actor, acting.visibility)
        this.permissions.assert(actor, "attachment:upload", loaded.subject)
        await this.quota.consume(orgId, "STORAGE_BYTES", file.bytes.length)
        const row = await this.attachments.create(orgId, {
          ticketId: file.ticketId,
          commentId: file.commentId,
          uploaderMembershipId: actor.membershipId,
          filename,
          declaredMimeType: declared,
          sizeBytes: file.bytes.length,
          storageKey: key,
        })
        await this.attachments.markReady(orgId, row.id, sniffed, this.clock.now())
        await this.audit.record(orgId, [
          {
            action: "ATTACHMENT_ADDED",
            entityType: "Ticket",
            entityId: file.ticketId,
            // Email never writes an internal note (DOMAIN.md §7.1).
            diff: { attachmentId: row.id, filename, sizeBytes: file.bytes.length, via: "email", internal: false },
          },
        ])
      })
    } catch (error) {
      await this.removeObject(key)
      if (error instanceof PlanLimitProblem) return { ok: false, reason: "the workspace's storage is full" }
      if (error instanceof NotPermittedProblem) return { ok: false, reason: "the sender may not attach files to this ticket" }
      throw error
    }
    return { ok: true }
  }

  async list(ticketId: string): Promise<Attachment[]> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    return this.prisma.transaction(async () => {
      const loaded = await this.access.load(orgId, ticketId, actor, this.visibility())
      const internal = this.permissions.can(actor, "comment:read_internal", loaded.subject)
      const rows = await this.attachments.listReady(orgId, ticketId, internal)
      return rows.map((row) => this.toAttachment(actor, row))
    })
  }

  async download(id: string): Promise<AttachmentDownload> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const row = await this.prisma.transaction(async () => {
      const found = await this.attachments.find(orgId, id)
      if (found === null || found.status !== "READY" || found.mimeType === null) throw new NotFoundProblem()
      const loaded = await this.access.load(orgId, found.ticketId, actor, this.visibility())
      this.assertVisible(actor, loaded, found)
      this.permissions.assertVisible(actor, "attachment:download", loaded.subject)
      return found
    })
    const mimeType = row.mimeType ?? row.declaredMimeType
    const inline = (INLINE_RENDERABLE_MIME_TYPES as readonly string[]).includes(mimeType)
    const url = await this.storage.presignGet(
      row.storageKey,
      { filename: row.filename, contentType: mimeType, inline },
      DOWNLOAD_TTL_SECONDS,
    )
    return { url, inline, expiresAt: new Date(this.clock.now().getTime() + DOWNLOAD_TTL_SECONDS * 1000).toISOString() }
  }

  async remove(id: string): Promise<void> {
    const actor = this.actors.requireTenantActor()
    const orgId = this.tenant.requireOrgId()
    const row = await this.prisma.transaction(async () => {
      const found = await this.attachments.find(orgId, id)
      if (found === null) throw new NotFoundProblem()
      this.assertVisible(actor, await this.access.load(orgId, found.ticketId, actor, this.visibility()), found)
      this.permissions.assert(actor, "attachment:delete", this.ownership(actor, found))
      // While its upload URL may still work, giving the quota back would let the URL store bytes for free.
      if (found.status !== "READY") throw new ConflictProblem("This upload is unfinished; it is cleared within the hour")
      if (!(await this.attachments.remove(orgId, id))) throw new NotFoundProblem()
      await this.quota.release(orgId, "STORAGE_BYTES", found.sizeBytes)
      await this.audit.record(orgId, [
        {
          action: "ATTACHMENT_REMOVED",
          entityType: "Ticket",
          entityId: found.ticketId,
          diff: { attachmentId: id, filename: found.filename, sizeBytes: found.sizeBytes },
        },
      ])
      return found
    })
    // The bytes go once the row has: a lost delete leaves an object nothing points at, never a row pointing at nothing.
    await this.removeObject(row.storageKey)
    await this.pulse.changed(orgId, row.ticketId, row.comment?.visibility === "INTERNAL" ? "internal" : "ticket")
  }

  private async removeObject(key: string): Promise<void> {
    try {
      await this.storage.remove(key)
    } catch (error) {
      this.logger.warn({ msg: "attachment object not removed", key, error: String(error) })
    }
  }

  /** A file on an internal note is as invisible as the note: `404`, not `403`. */
  private assertVisible(actor: TenantActor, loaded: LoadedTicket, row: AttachmentRow): void {
    if (row.comment !== null && (row.comment.deletedAt !== null || row.comment.visibility === "INTERNAL")) {
      if (row.comment.deletedAt !== null) throw new NotFoundProblem()
      this.permissions.assertVisible(actor, "comment:read_internal", loaded.subject)
    }
  }

  /** `own` is the uploader here, and the window is measured from the upload (RBAC.md §6). */
  private ownership(actor: TenantActor, row: AttachmentRow): Subject {
    return {
      own: row.uploaderMembershipId === actor.membershipId,
      withinEditWindow: this.clock.now().getTime() - row.createdAt.getTime() <= WINDOW_MS,
    }
  }

  private toAttachment(actor: TenantActor, row: AttachmentRow): Attachment {
    return {
      id: row.id,
      ticketId: row.ticketId,
      commentId: row.commentId,
      filename: row.filename,
      mimeType: row.mimeType ?? row.declaredMimeType,
      sizeBytes: row.sizeBytes,
      status: row.status,
      uploader: { membershipId: row.uploader.id, displayName: row.uploader.displayName },
      createdAt: row.createdAt.toISOString(),
      canDelete: this.permissions.can(actor, "attachment:delete", this.ownership(actor, row)),
    }
  }

  private visibility() {
    const org = this.tenant.organization()
    if (org === undefined) throw new NotFoundProblem()
    return org.agentVisibility
  }
}

/**
 * Where the browser's PUT lands (ADR-0038): `staging/` + the final key. Only
 * the presigned URL writes here; `complete` copies checked bytes out, and a
 * bucket lifecycle rule expires whatever is left.
 */
export function stagingKey(storageKey: string): string {
  return `staging/${storageKey}`
}

/** `org/<orgId>/tickets/<ticketId>/<uuid>-<name>`: the tenant first, a fresh id, a name safe as a key. */
export function storageKey(orgId: string, ticketId: string, filename: string): string {
  const safe =
    filename
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/^[._]+/, "")
      .slice(-100) || "file"
  return `org/${orgId}/tickets/${ticketId}/${uuidv7()}-${safe}`
}
