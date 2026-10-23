import { Logger } from "@nestjs/common"
import type { Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor } from "../auth/actor"
import type { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { FixedClock } from "../common/clock/clock"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem, ValidationProblem } from "../common/problems/problem.exception"
import type { TicketPulse } from "../notifications/live/ticket-pulse"
import type { PrismaService } from "../prisma/prisma.service"
import type { QuotaService } from "../quota/quota.service"
import type { StorageService } from "../storage/storage.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import type { CommentRepository } from "../tickets/repositories/comment.repository"
import type { TicketAccess } from "../tickets/ticket-access"
import { AttachmentsService, storageKey } from "./attachments.service"
import type { AttachmentRepository, AttachmentRow } from "./repositories/attachment.repository"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const NOW = new Date("2026-10-14T09:00:00.000Z")
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])

const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: "a-1",
  ticketId: "t-1",
  commentId: null,
  uploaderMembershipId: "m-me",
  filename: "shot.png",
  declaredMimeType: "image/png",
  mimeType: null,
  sizeBytes: PNG.length,
  storageKey: "org/o/tickets/t-1/x-shot.png",
  status: "PENDING",
  createdAt: NOW,
  uploader: { id: "m-me", displayName: "Me" },
  comment: null,
  ...over,
})

function harness(
  role: Role,
  found: AttachmentRow | null = row(),
  options: {
    stored?: number | null
    bytes?: Uint8Array
    status?: string
    comment?: { visibility: "PUBLIC" | "INTERNAL"; deletedAt: Date | null } | null
    own?: boolean
    now?: Date
  } = {},
) {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined)
  const actor: MemberActor = { kind: "member", userId: "u", orgId: ORG, membershipId: "m-me", role, teamIds: [], leadOfTeamIds: [] }
  const attachments = {
    create: vi.fn(async (_o: string, data: Partial<AttachmentRow>) => row({ ...data, status: "PENDING" })),
    find: vi.fn(async () => found),
    listReady: vi.fn(async () => []),
    markReady: vi.fn(async () => true),
    remove: vi.fn(async () => true),
  }
  const storage = {
    presignPut: vi.fn(async () => ({
      url: "http://localhost:9000/b/k?sig",
      headers: { "Content-Type": "image/png" },
      expiresAt: new Date(NOW.getTime() + 300_000),
    })),
    presignGet: vi.fn(async () => "http://localhost:9000/b/k?get"),
    size: vi.fn(async () => (options.stored === undefined ? PNG.length : options.stored)),
    readStart: vi.fn(async () => options.bytes ?? PNG),
    remove: vi.fn(async () => undefined),
    copy: vi.fn(async () => undefined),
  }
  const quota = { consume: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const audit = { record: vi.fn(async () => undefined) }
  const own = options.own ?? role === "REQUESTER"
  const service = new AttachmentsService(
    attachments as unknown as AttachmentRepository,
    {
      find: vi.fn(async () => (options.comment === undefined ? null : options.comment === null ? null : { ...options.comment, id: "c-1" })),
    } as unknown as CommentRepository,
    {
      load: vi.fn(async () => ({
        row: { id: "t-1", status: options.status ?? "IN_PROGRESS" },
        subject: { own, watch: false, scope: role !== "REQUESTER", ticketType: "INCIDENT", ticketStatus: options.status ?? "IN_PROGRESS" },
        relation: { role, isRequester: own, isAssignee: false, ticketHasAssignee: false },
      })),
    } as unknown as TicketAccess,
    storage as unknown as StorageService,
    quota as unknown as QuotaService,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => ORG, organization: () => ({ agentVisibility: "ALL_TICKETS" }) } as unknown as TenantContextService,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
    audit as unknown as AuditService,
    { changed: vi.fn(async () => undefined) } as unknown as TicketPulse,
    new FixedClock(options.now ?? NOW),
  )
  return { service, attachments, storage, quota, audit }
}

const presign = { ticketId: "t-1", filename: "shot.png", mimeType: "image/png" as const, sizeBytes: PNG.length }

describe("AttachmentsService.presign", () => {
  it("takes the storage quota for the declared size and signs exactly that upload", async () => {
    const h = harness("REQUESTER")
    const out = await h.service.presign(presign)
    expect(h.quota.consume).toHaveBeenCalledWith(ORG, "STORAGE_BYTES", PNG.length)
    expect(h.storage.presignPut).toHaveBeenCalledWith(
      expect.stringMatching(/^staging\/org\/0190b2f0-.*\/tickets\/t-1\/.*-shot\.png$/),
      "image/png",
      PNG.length,
      300,
      NOW,
    )
    expect(out.upload).toMatchObject({ method: "PUT", url: "http://localhost:9000/b/k?sig" })
  })

  it("refuses a closed ticket, a requester on someone else's, and an internal note to a requester", async () => {
    await expect(harness("AGENT", row(), { status: "CLOSED" }).service.presign(presign)).rejects.toBeInstanceOf(ConflictProblem)
    await expect(harness("REQUESTER", row(), { own: false }).service.presign(presign)).rejects.toBeInstanceOf(NotPermittedProblem)
    await expect(
      harness("REQUESTER", row(), { comment: { visibility: "INTERNAL", deletedAt: null } }).service.presign({
        ...presign,
        commentId: "c-1",
      }),
    ).rejects.toBeInstanceOf(NotFoundProblem)
    await expect(harness("AGENT", row(), { comment: null }).service.presign({ ...presign, commentId: "c-missing" })).rejects.toBeInstanceOf(
      NotFoundProblem,
    )
  })
})

describe("AttachmentsService.complete", () => {
  it("marks a file READY as what its bytes are, and audits it", async () => {
    const h = harness("AGENT")
    const done = await h.service.complete("a-1")
    expect(h.attachments.markReady).toHaveBeenCalledWith(ORG, "a-1", "image/png", NOW)
    expect(done).toMatchObject({ status: "READY", mimeType: "image/png" })
    // Sniffed in staging, then copied where no upload URL reaches (ADR-0038).
    expect(h.storage.readStart).toHaveBeenCalledWith("staging/org/o/tickets/t-1/x-shot.png", expect.any(Number))
    expect(h.storage.copy).toHaveBeenCalledWith("staging/org/o/tickets/t-1/x-shot.png", "org/o/tickets/t-1/x-shot.png")
    expect(h.audit.record).toHaveBeenCalledWith(ORG, [expect.objectContaining({ action: "ATTACHMENT_ADDED" })])
  })

  it("throws away bytes that are not what they claim, or not the size signed — but keeps the row and quota for the sweep", async () => {
    for (const options of [{ bytes: new TextEncoder().encode("<svg onload=alert(1)>") }, { stored: 999 }]) {
      const h = harness("AGENT", row(), options)
      await expect(h.service.complete("a-1")).rejects.toBeInstanceOf(ValidationProblem)
      expect(h.storage.remove).toHaveBeenCalledWith("staging/org/o/tickets/t-1/x-shot.png")
      // Released now, the still-valid upload URL could store bytes for free.
      expect(h.attachments.remove).not.toHaveBeenCalled()
      expect(h.quota.release).not.toHaveBeenCalled()
      expect(h.storage.copy).not.toHaveBeenCalled()
      expect(h.attachments.markReady).not.toHaveBeenCalled()
    }
  })

  it("removes its own copy when the sweep took the row meanwhile, instead of orphaning it", async () => {
    const h = harness("AGENT")
    h.attachments.markReady.mockResolvedValueOnce(false)
    await expect(h.service.complete("a-1")).rejects.toBeInstanceOf(NotFoundProblem)
    expect(h.storage.copy).toHaveBeenCalledWith("staging/org/o/tickets/t-1/x-shot.png", "org/o/tickets/t-1/x-shot.png")
    expect(h.storage.remove).toHaveBeenCalledWith("org/o/tickets/t-1/x-shot.png")
    expect(h.audit.record).not.toHaveBeenCalled()
  })

  it("is a 409 before anything is uploaded, and a 404 for someone else's upload", async () => {
    await expect(harness("AGENT", row(), { stored: null }).service.complete("a-1")).rejects.toBeInstanceOf(ConflictProblem)
    await expect(harness("AGENT", row({ uploaderMembershipId: "m-other" })).service.complete("a-1")).rejects.toBeInstanceOf(NotFoundProblem)
  })
})

describe("AttachmentsService.download and remove", () => {
  const ready = row({ status: "READY", mimeType: "application/pdf", filename: "report.pdf" })

  it("serves a ready file as its sniffed type, inline only for a raster image", async () => {
    const pdf = harness("AGENT", ready)
    expect(await pdf.service.download("a-1")).toMatchObject({ inline: false })
    expect(pdf.storage.presignGet).toHaveBeenCalledWith(
      ready.storageKey,
      { filename: "report.pdf", contentType: "application/pdf", inline: false },
      120,
    )
    const png = harness("AGENT", row({ status: "READY", mimeType: "image/png" }))
    expect(await png.service.download("a-1")).toMatchObject({ inline: true })
  })

  it("hides a file on an internal note from a requester as a 404, and a pending one from everyone", async () => {
    const internal = row({ status: "READY", mimeType: "image/png", comment: { visibility: "INTERNAL", deletedAt: null } })
    await expect(harness("REQUESTER", internal).service.download("a-1")).rejects.toBeInstanceOf(NotFoundProblem)
    await expect(harness("AGENT", row()).service.download("a-1")).rejects.toBeInstanceOf(NotFoundProblem)
  })

  it("lets an uploader remove their own within the window, an agent theirs any time, an admin anything", async () => {
    const late = new Date(NOW.getTime() + 16 * 60_000)
    await expect(harness("REQUESTER", ready, { now: late }).service.remove("a-1")).rejects.toBeInstanceOf(NotPermittedProblem)
    const requester = harness("REQUESTER", ready)
    await requester.service.remove("a-1")
    expect(requester.quota.release).toHaveBeenCalledWith(ORG, "STORAGE_BYTES", ready.sizeBytes)
    expect(requester.storage.remove).toHaveBeenCalled()
    await expect(harness("AGENT", row({ ...ready, uploaderMembershipId: "m-other" })).service.remove("a-1")).rejects.toBeInstanceOf(
      NotPermittedProblem,
    )
    await harness("ADMIN", row({ ...ready, uploaderMembershipId: "m-other" })).service.remove("a-1")
  })

  it("leaves an unfinished upload to the sweep: deleting it is a 409", async () => {
    const h = harness("REQUESTER", row())
    await expect(h.service.remove("a-1")).rejects.toBeInstanceOf(ConflictProblem)
    expect(h.quota.release).not.toHaveBeenCalled()
  })
})

describe("storage keys", () => {
  it("start with the tenant, carry a fresh id, and keep only safe characters", () => {
    const key = storageKey(ORG, "t-1", "../../etc/pass wd é.txt")
    expect(key).toMatch(new RegExp(`^org/${ORG}/tickets/t-1/[0-9a-f-]{36}-etc_pass_wd_e_.txt$`))
    expect(storageKey(ORG, "t-1", "...")).toMatch(/-file$/)
  })
})
