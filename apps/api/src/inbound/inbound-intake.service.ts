import { createHash } from "node:crypto"

import { Injectable, Logger } from "@nestjs/common"
import { createTicketRequestSchema, INBOUND_SUBDOMAIN, type InboundOutcome } from "@patchgrid/contracts"
import { type ParsedMail, simpleParser } from "mailparser"
import { v7 as uuidv7 } from "uuid"

import { AttachmentsService } from "../attachments/attachments.service"
import type { TenantActor } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { AuditService } from "../audit/audit.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import { ConflictProblem, NotFoundProblem, NotPermittedProblem } from "../common/problems/problem.exception"
import { type AppConfig, InjectConfig } from "../config/app-config"
import { MembershipRepository } from "../memberships/repositories/membership.repository"
import { PrismaService } from "../prisma/prisma.service"
import { StorageService } from "../storage/storage.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { OrganizationLookupService } from "../tenancy/organization-lookup.service"
import { CommentsService } from "../tickets/comments.service"
import { canonicalLink } from "../tickets/domain/links"
import { LinkRepository } from "../tickets/repositories/link.repository"
import { TicketRepository } from "../tickets/repositories/ticket.repository"
import { type Acting, TicketAccess } from "../tickets/ticket-access"
import { TicketsService } from "../tickets/tickets.service"
import { automaticReason } from "./domain/auto-reply"
import { replyText } from "./domain/reply-text"
import { storableText, truncate } from "./domain/text"
import { ticketReference, titleFromSubject } from "./domain/threading"
import { verdictFrom } from "./domain/verdict"
import { InboundEmailRepository, type SkippedAttachment } from "./repositories/inbound-email.repository"

/** One sender's mail to one workspace in an hour, before the rest waits (ADR-0027 §6). */
export const SENDER_HOURLY_LIMIT = 20
/** Files taken from one message; the rest are listed as skipped. */
export const MAX_FILES_PER_MESSAGE = 10
const DESCRIPTION_LIMIT = 20_000
const HOUR_MS = 60 * 60_000
/** How long a worker's claim on a message holds before another may take it over. */
const CLAIM_MS = 60_000

/** Another worker holds this message; this attempt must not release its claim. */
export class InboundBusyError extends Error {
  constructor(id: string) {
    super(`inbound message ${id} is being processed elsewhere`)
  }
}

export type InboundJob = { orgId: string; rawStorageKey: string; receivedAt: string }

/**
 * The inbound pipeline inside one tenant (ADR-0027, ADR-0039), run by the
 * `inbound-email` job in that tenant's context. In order: parse; record the
 * message with its verdict; refuse anything not DMARC-aligned, automatic,
 * over the sender's hourly limit, or from no active member; then reply on a
 * ticket the sender takes part in, or open a new one. Every message that got
 * this far leaves a row saying what became of it.
 */
@Injectable()
export class InboundIntakeService {
  private readonly logger = new Logger(InboundIntakeService.name)

  constructor(
    private readonly inbound: InboundEmailRepository,
    private readonly memberships: MembershipRepository,
    private readonly tickets: TicketRepository,
    private readonly links: LinkRepository,
    private readonly ticketsService: TicketsService,
    private readonly access: TicketAccess,
    private readonly permissions: PermissionService,
    private readonly comments: CommentsService,
    private readonly attachments: AttachmentsService,
    private readonly storage: StorageService,
    private readonly lookup: OrganizationLookupService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectConfig() private readonly config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /**
   * `last` is whether this is the job's final attempt: a failure then settles
   * the message `FAILED`, any earlier one lets go of it for the retry.
   */
  async process(job: InboundJob, attempt: { last: boolean } = { last: true }): Promise<InboundOutcome | "duplicate" | "missing"> {
    const orgId = this.tenant.requireOrgId()
    const raw = await this.storage.read(job.rawStorageKey)
    if (raw === null) {
      this.logger.warn({ msg: "inbound message not in storage", orgId, key: job.rawStorageKey })
      return "missing"
    }
    const bytes = Buffer.from(raw)
    const digest = createHash("sha256").update(bytes).digest("hex")
    let mail: ParsedMail | null = null
    try {
      mail = await simpleParser(bytes, { skipImageLinks: true })
    } catch (error) {
      this.logger.warn({ msg: "inbound message unreadable", orgId, error: String(error) })
    }

    const sender = mail === null ? null : singleSender(mail)
    const fromAddress = truncate(storableText(sender ?? mail?.from?.text ?? ""), 320)
    const subject = truncate(storableText((mail?.subject ?? "").replace(/[\r\n]+/g, " ")), 998)
    // One From, one mailbox — or nobody: DMARC judged one address, and the intake must act as that one.
    const verdict = mail === null || sender === null ? "NONE" : verdictFrom(authenticationResults(mail), this.config.INBOUND_AUTHSERV_ID, sender)
    const row = await this.inbound.receive(orgId, {
      id: uuidv7(),
      messageKey: truncate(storableText(mail?.messageId ?? `<sha256.${digest}@patchgrid.invalid>`), 998),
      fromAddress,
      subject,
      authVerdict: verdict,
      rawStorageKey: job.rawStorageKey,
      receivedAt: new Date(job.receivedAt),
    })
    if (row.replacedRawKey !== null) await this.storage.remove(row.replacedRawKey).catch(() => undefined)
    // Only a row nothing has become of yet: a retry after a finished message is a no-op.
    if (row.outcome !== "RECEIVED") return "duplicate"
    const now = this.clock.now()
    if (!(await this.inbound.claim(orgId, row.id, now, new Date(now.getTime() - CLAIM_MS)))) {
      // The same message, delivered twice, in another worker's hands; BullMQ retries this one.
      throw new InboundBusyError(row.id)
    }
    try {
      return await this.decide(orgId, row.id, mail, { fromAddress, subject, verdict })
    } catch (error) {
      if (attempt.last) await this.inbound.failReceived(orgId, row.id, truncate(String(error), 500), this.clock.now())
      else await this.inbound.release(orgId, row.id)
      throw error
    }
  }

  /** Everything after the row is claimed: refuse, or act exactly once. */
  private async decide(
    orgId: string,
    inboundId: string,
    mail: ParsedMail | null,
    facts: { fromAddress: string; subject: string; verdict: "PASS" | "FAIL" | "NONE" },
  ): Promise<InboundOutcome> {
    const { fromAddress, subject, verdict } = facts
    const settle = async (
      outcome: InboundOutcome,
      extra: { senderMembershipId?: string; ticketId?: string; skippedAttachments?: SkippedAttachment[]; error?: string } = {},
    ) => {
      await this.inbound.settle(orgId, inboundId, { outcome, ...extra, processedAt: this.clock.now() })
      this.logger.log({ msg: "inbound message settled", orgId, inboundEmailId: inboundId, outcome })
      return outcome
    }

    if (mail === null) return settle("FAILED", { error: "The message could not be read" })
    // No reply to a sender who may be forged: answering is how a desk becomes a backscatter source.
    if (verdict !== "PASS") return settle("UNAUTHENTICATED")
    const automatic = automaticReason((name) => headerText(mail, name), fromAddress)
    if (automatic !== null) return settle("AUTO_REPLY", { error: automatic })
    const since = new Date(this.clock.now().getTime() - HOUR_MS)
    if ((await this.inbound.countFrom(orgId, fromAddress, since)) > SENDER_HOURLY_LIMIT) return settle("RATE_LIMITED")

    const org = await this.lookup.byId(orgId)
    // Suspended between the webhook and this job: nothing more lands in it.
    if (org === null || org.status !== "ACTIVE") return settle("FAILED", { error: "The workspace is not active" })
    // The verified address is the credential.
    const actor = await this.senderActor(orgId, fromAddress, mail)
    if (actor === null) return settle("UNKNOWN_SENDER")
    const member = { id: actor.membershipId }
    const acting: Acting = { actor, visibility: org.agentVisibility }
    const text = storableText(bodyText(mail))

    const referenced = await this.referencedTicket(orgId, mail, subject)
    if (referenced !== null) {
      const commentId = await this.reply(acting, referenced, replyText(text), () =>
        this.inbound.markActed(orgId, inboundId, { outcome: "THREADED", ticketId: referenced, senderMembershipId: member.id }),
      )
      if (commentId !== null) {
        const skipped = await this.files(acting, mail, referenced, commentId)
        return settle("THREADED", { senderMembershipId: member.id, ticketId: referenced, skippedAttachments: skipped })
      }
    }

    // Through the contract, as a request body would be: the title and text fit the ticket's own rules.
    const request = createTicketRequestSchema.parse({
      type: "INCIDENT",
      title: titleFromSubject(subject),
      description: truncate(text === "" ? "(no text)" : text, DESCRIPTION_LIMIT),
      impact: "LOW",
      urgency: "MEDIUM",
    })
    const ticketId = await this.ticketsService.createAs(acting, request, {
      source: "EMAIL",
      within: (id) => this.inbound.markActed(orgId, inboundId, { outcome: "CREATED", ticketId: id, senderMembershipId: member.id }),
    })
    // From here the ticket exists and the row says so; what follows is best effort, never a reason to retry.
    // Naming a ticket the sender may not post on opens a new one beside it — never a reply on it (ADR-0027 §5).
    if (referenced !== null) {
      await this.relate(orgId, acting, ticketId, referenced).catch((error: unknown) =>
        this.logger.warn({ msg: "inbound relate failed", orgId, ticketId, error: String(error) }),
      )
    }
    const skipped = await this.files(acting, mail, ticketId, null)
    return settle("CREATED", { senderMembershipId: member.id, ticketId, skippedAttachments: skipped })
  }

  /**
   * Who the verified address acts as. An active member, as AuthGuard would
   * build them from a token. Otherwise, when the workspace takes outside
   * mail (ADR-0027 §4), the address's external requester — made on their
   * first message, and refused once an admin has paused or removed them.
   * `null`: nobody this workspace takes mail from.
   */
  private async senderActor(orgId: string, address: string, mail: ParsedMail): Promise<TenantActor | null> {
    const member = await this.memberships.findByEmail(orgId, address)
    if (member !== null) {
      if (member.status !== "ACTIVE" || member.kind !== "HUMAN" || member.userId === null) return null
      return {
        kind: "member",
        userId: member.userId,
        orgId,
        membershipId: member.id,
        role: member.role,
        teamIds: member.teamIds,
        leadOfTeamIds: member.leadOfTeamIds,
      }
    }
    if (!(await this.inbound.acceptsExternal(orgId))) return null
    const name = truncate(storableText(mail.from?.value[0]?.name ?? ""), 100) || address.split("@")[0] || address
    const external = await this.prisma.transaction(() => this.memberships.findOrCreateExternal(orgId, address, name, this.clock.now()))
    if (external?.status !== "ACTIVE") return null
    return { kind: "external", orgId, membershipId: external.id, role: "REQUESTER" }
  }

  /** The ticket a message is about, if it names one in this org; whether the sender may post there is `reply`'s question. */
  private async referencedTicket(orgId: string, mail: ParsedMail, subject: string): Promise<string | null> {
    const reference = ticketReference({
      inReplyTo: mail.inReplyTo,
      references: typeof mail.references === "string" ? [mail.references] : (mail.references ?? []),
      subject,
      inboundDomain: `${INBOUND_SUBDOMAIN}.${this.config.ROOT_DOMAIN}`,
    })
    if (reference === null) return null
    // RLS and the explicit org together: an id from another tenant's mail finds nothing here.
    if (reference.kind === "id") return (await this.tickets.findById(orgId, reference.ticketId))?.id ?? null
    return this.tickets.findIdByNumber(orgId, reference.type, reference.number)
  }

  /**
   * A public reply, as the sender — only when they may read the ticket and
   * reply on it. `null` when they may not, or it takes no more replies: the
   * message then opens a ticket of its own.
   */
  private async reply(acting: Acting, ticketId: string, body: string, within: (commentId: string) => Promise<void>): Promise<string | null> {
    try {
      const { created } = await this.comments.addAs(
        acting,
        ticketId,
        { body: truncate(body === "" ? "(no text)" : body, DESCRIPTION_LIMIT), visibility: "PUBLIC" },
        { within },
      )
      return created.id
    } catch (error) {
      if (error instanceof NotFoundProblem || error instanceof NotPermittedProblem || error instanceof ConflictProblem) return null
      throw error
    }
  }

  /**
   * `RELATES_TO`, stored in its canonical order, by the sender and audited as
   * theirs — only when the sender could have made the link through the API:
   * a ticket they cannot see, or may not link, gets nothing attached (M9 review).
   */
  private async relate(orgId: string, acting: Acting, ticketId: string, referenced: string): Promise<void> {
    const membershipId = acting.actor.membershipId
    const visible = await this.access.loadVisible(orgId, [referenced], acting.actor, acting.visibility)
    const target = visible[0]
    if (target === undefined || !this.permissions.can(acting.actor, "ticket:link", target.subject)) return
    const [created, other] = await this.tickets.findManyById(orgId, [ticketId, referenced]).then((rows) => [
      rows.find((r) => r.id === ticketId),
      rows.find((r) => r.id === referenced),
    ])
    if (created === undefined || other === undefined) return
    const made = canonicalLink("RELATES_TO", { id: created.id, type: created.type }, { id: other.id, type: other.type })
    if (!made.ok) return
    await this.prisma.transaction(async () => {
      await this.links.createMany(orgId, [made.link], membershipId)
      await this.audit.record(orgId, [{ action: "TICKET_LINKED", entityType: "Ticket", entityId: ticketId, diff: { ...made.link, via: "email" } }])
    })
  }

  /** The message's files, through the attachment rules; what is left out is listed, never fatal. */
  private async files(acting: Acting, mail: ParsedMail, ticketId: string, commentId: string | null): Promise<SkippedAttachment[]> {
    const skipped: SkippedAttachment[] = []
    // An image the HTML embeds (a signature logo) is part of the text, not a file someone sent.
    const files = mail.attachments.filter((a) => a.related !== true)
    for (const [index, file] of files.entries()) {
      const filename = truncate(storableText(file.filename ?? `attachment-${String(index + 1)}`), 255)
      if (index >= MAX_FILES_PER_MESSAGE) {
        skipped.push({ filename, reason: `more than ${String(MAX_FILES_PER_MESSAGE)} files` })
        continue
      }
      try {
        const result = await this.attachments.ingest(acting, { ticketId, commentId, filename, contentType: file.contentType, bytes: file.content })
        if (!result.ok) skipped.push({ filename, reason: result.reason })
      } catch (error) {
        // The ticket is made; a file that could not be stored is listed, not retried into a second ticket.
        this.logger.warn({ msg: "inbound file not stored", orgId: this.tenant.requireOrgId(), ticketId, error: String(error) })
        skipped.push({ filename, reason: "could not be stored" })
      }
    }
    return skipped
  }
}

/**
 * The one address the message is from, or `null`: two `From:` headers, a
 * list of mailboxes or a group are each refused, because DMARC judged one
 * address and mailparser may hand back another (ADR-0039).
 */
function singleSender(mail: ParsedMail): string | null {
  if (mail.headerLines.filter((line) => line.key === "from").length !== 1) return null
  const mailboxes = mail.from?.value ?? []
  const only = mailboxes[0]
  if (mailboxes.length !== 1 || only === undefined || only.group !== undefined || only.address === undefined || only.address === "") return null
  return only.address.trim().toLowerCase()
}

/** Every `Authentication-Results` value, top of the message first, as received. */
function authenticationResults(mail: ParsedMail): string[] {
  return mail.headerLines.filter((line) => line.key === "authentication-results").map((line) => line.line.replace(/^[^:]*:\s*/, ""))
}

/** A header as text, whatever shape mailparser gave it. */
function headerText(mail: ParsedMail, name: string): string | undefined {
  const value: unknown = mail.headers.get(name)
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (typeof value === "object" && "value" in value && typeof value.value === "string") return value.value
  if (typeof value === "object" && "text" in value && typeof value.text === "string") return value.text
  return String(value)
}

/** The plain text; mailparser derives it from the HTML when a message has none. */
function bodyText(mail: ParsedMail): string {
  return (mail.text ?? "").replace(/\r\n?/g, "\n").trim()
}
