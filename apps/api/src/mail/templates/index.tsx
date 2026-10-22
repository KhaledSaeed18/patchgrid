import { emailSchema, idSchema } from "@patchgrid/contracts"
import { render } from "@react-email/render"
import type { ReactElement } from "react"
import { z } from "zod"

import { AccountExists } from "./account-exists"
import { ACCOUNT_SECURITY_EVENTS, AccountSecurity, accountSecuritySubject } from "./account-security"
import { Invite } from "./invite"
import { ResetPassword } from "./reset-password"
import { ApiTokenExpiring, apiTokenExpiringSubject } from "./api-token-expiring"
import { AccountErased, accountErasedSubject } from "./account-erased"
import { ExportReady, exportReadySubject } from "./export-ready"
import { OrgDeletion, orgDeletionSubject } from "./org-deletion"
import { PlatformSecurity, platformSecuritySubject } from "./platform-security"
import { SupportAccess, supportSubject } from "./support-access"
import { TicketNotification } from "./ticket-notification"
import { VerifyEmail } from "./verify-email"

/**
 * Every message the system sends, as a typed registry. A job's payload is
 * validated against this when it is DEQUEUED — Redis hands back `unknown`,
 * and a payload written by a previous deploy may not be one this code knows.
 *
 * Payloads carry the finished URLs, token included. That is the one place the
 * design accepts a secret in a job: the token row stores only a hash, so the
 * link cannot be rebuilt later, and completed jobs are removed from Redis.
 */
// Only web links: a `javascript:` or `data:` URL in a mail button is an attack, never a template.
const url = z.url({ protocol: /^https?$/ })

export const MAIL_KINDS = {
  "verify-email": {
    params: z.object({ name: z.string(), verifyUrl: url, expiresInHours: z.int().positive() }),
    subject: () => "Verify your Patchgrid address",
    component: VerifyEmail,
  },
  "account-exists": {
    params: z.object({ name: z.string(), loginUrl: url, resetUrl: url }),
    subject: () => "You already have a Patchgrid account",
    component: AccountExists,
  },
  invite: {
    params: z.object({
      orgName: z.string(),
      inviterName: z.string(),
      role: z.string(),
      acceptUrl: url,
      expiresInDays: z.int().positive(),
    }),
    subject: (p: { orgName: string }) => `You're invited to ${p.orgName} on Patchgrid`,
    component: Invite,
  },
  "reset-password": {
    params: z.object({ name: z.string(), resetUrl: url, expiresInMinutes: z.int().positive() }),
    subject: () => "Reset your Patchgrid password",
    component: ResetPassword,
  },
  "ticket-notification": {
    params: z.object({
      orgName: z.string(),
      headline: z.string(),
      reason: z.string(),
      ticketUrl: url,
      preferencesUrl: url,
      /** The ticket, for the Message-ID a reply will quote back (ADR-0039). */
      ticketId: idSchema,
      /** `INC-000042`, tagged into the subject for a reply that keeps no headers. */
      ticketNumber: z.string().regex(/^[A-Z]{2,4}-\d{1,9}$/),
      /** The workspace's inbound address: replying adds to the ticket. */
      replyTo: emailSchema,
    }),
    // A ticket title is typed by a tenant; a subject is a header, and stays one line.
    subject: (p: { headline: string; ticketNumber: string }) => taggedSubject(p.headline.replace(/[\r\n]+/g, " "), p.ticketNumber),
    component: TicketNotification,
  },
  "support-access": {
    params: z.object({
      orgName: z.string(),
      operatorName: z.string(),
      event: z.enum(["requested", "granted", "first-use", "ended"]),
      detail: z.string().max(500),
      settingsUrl: url,
    }),
    subject: supportSubject,
    component: SupportAccess,
  },
  "api-token-expiring": {
    params: z.object({
      orgName: z.string(),
      tokenName: z.string().max(80),
      prefix: z.string().regex(/^[a-z0-9]{12}$/),
      expiresOn: z.string().max(100),
      settingsUrl: url,
    }),
    subject: apiTokenExpiringSubject,
    component: ApiTokenExpiring,
  },
  "org-deletion": {
    params: z.object({
      orgName: z.string(),
      event: z.enum(["requested", "cancelled"]),
      actorName: z.string().max(200),
      purgeOn: z.string().max(100),
      workspacesUrl: url,
    }),
    subject: orgDeletionSubject,
    component: OrgDeletion,
  },
  "export-ready": {
    params: z.object({
      orgName: z.string(),
      downloadUrl: url,
      expiresOn: z.string().max(100),
      sizeLabel: z.string().max(40),
    }),
    subject: exportReadySubject,
    component: ExportReady,
  },
  "account-erased": {
    params: z.object({ workspaceCount: z.int().nonnegative() }),
    subject: accountErasedSubject,
    component: AccountErased,
  },
  "platform-security": {
    params: z.object({ event: z.enum(["factor-locked", "recovery-code-used"]), remaining: z.int().nonnegative() }),
    subject: platformSecuritySubject,
    component: PlatformSecurity,
  },
  "account-security": {
    params: z.object({
      event: z.enum(ACCOUNT_SECURITY_EVENTS),
      remaining: z.int().nonnegative(),
    }),
    subject: accountSecuritySubject,
    component: AccountSecurity,
  },
} as const

export type MailKind = keyof typeof MAIL_KINDS

const envelope = {
  to: emailSchema,
  /** The tenant the message belongs to, or none. Rendering runs in that context (ADR-0018). */
  orgId: idSchema.nullable(),
  /** The `From` display name — the organization's, on tenant mail. */
  fromName: z.string().min(1).max(100),
}

export const mailJobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("verify-email"), ...envelope, params: MAIL_KINDS["verify-email"].params }),
  z.object({ kind: z.literal("account-exists"), ...envelope, params: MAIL_KINDS["account-exists"].params }),
  z.object({ kind: z.literal("invite"), ...envelope, params: MAIL_KINDS.invite.params }),
  z.object({ kind: z.literal("reset-password"), ...envelope, params: MAIL_KINDS["reset-password"].params }),
  z.object({ kind: z.literal("ticket-notification"), ...envelope, params: MAIL_KINDS["ticket-notification"].params }),
  z.object({ kind: z.literal("support-access"), ...envelope, params: MAIL_KINDS["support-access"].params }),
  z.object({ kind: z.literal("api-token-expiring"), ...envelope, params: MAIL_KINDS["api-token-expiring"].params }),
  z.object({ kind: z.literal("org-deletion"), ...envelope, params: MAIL_KINDS["org-deletion"].params }),
  z.object({ kind: z.literal("export-ready"), ...envelope, params: MAIL_KINDS["export-ready"].params }),
  z.object({ kind: z.literal("account-erased"), ...envelope, params: MAIL_KINDS["account-erased"].params }),
  z.object({ kind: z.literal("platform-security"), ...envelope, params: MAIL_KINDS["platform-security"].params }),
  z.object({ kind: z.literal("account-security"), ...envelope, params: MAIL_KINDS["account-security"].params }),
])
export type MailJob = z.infer<typeof mailJobSchema>

export type RenderedMail = { subject: string; html: string; text: string }

/**
 * The ticket number bracketed where the headline already says it —
 * `Assigned to you — [INC-000042]: Printer` — or first when it does not, so a
 * reply that keeps no headers still names its ticket (ADR-0027 §5).
 */
export function taggedSubject(headline: string, number: string): string {
  return headline.includes(number) ? headline.replace(number, `[${number}]`) : `[${number}] ${headline}`
}

export async function renderMail(job: MailJob): Promise<RenderedMail> {
  const element = elementFor(job)
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })])
  return { subject: subjectFor(job), html, text }
}

function elementFor(job: MailJob): ReactElement {
  switch (job.kind) {
    case "verify-email":
      return <VerifyEmail {...job.params} />
    case "account-exists":
      return <AccountExists {...job.params} />
    case "invite":
      return <Invite {...job.params} />
    case "reset-password":
      return <ResetPassword {...job.params} />
    case "ticket-notification":
      return <TicketNotification {...job.params} />
    case "support-access":
      return <SupportAccess {...job.params} />
    case "api-token-expiring":
      return <ApiTokenExpiring {...job.params} />
    case "org-deletion":
      return <OrgDeletion {...job.params} />
    case "export-ready":
      return <ExportReady {...job.params} />
    case "account-erased":
      return <AccountErased {...job.params} />
    case "platform-security":
      return <PlatformSecurity {...job.params} />
    case "account-security":
      return <AccountSecurity {...job.params} />
  }
}

function subjectFor(job: MailJob): string {
  switch (job.kind) {
    case "invite":
      return MAIL_KINDS.invite.subject(job.params)
    case "ticket-notification":
      return MAIL_KINDS["ticket-notification"].subject(job.params)
    case "support-access":
      return MAIL_KINDS["support-access"].subject(job.params)
    case "api-token-expiring":
      return MAIL_KINDS["api-token-expiring"].subject(job.params)
    case "org-deletion":
      return MAIL_KINDS["org-deletion"].subject(job.params)
    case "export-ready":
      return MAIL_KINDS["export-ready"].subject(job.params)
    case "platform-security":
      return MAIL_KINDS["platform-security"].subject(job.params)
    case "account-security":
      return MAIL_KINDS["account-security"].subject(job.params)
    default:
      return MAIL_KINDS[job.kind].subject()
  }
}
