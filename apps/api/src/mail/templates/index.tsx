import { emailSchema, idSchema } from "@patchgrid/contracts"
import { render } from "@react-email/render"
import type { ReactElement } from "react"
import { z } from "zod"

import { AccountExists } from "./account-exists"
import { Invite } from "./invite"
import { ResetPassword } from "./reset-password"
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
])
export type MailJob = z.infer<typeof mailJobSchema>

export type RenderedMail = { subject: string; html: string; text: string }

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
  }
}

function subjectFor(job: MailJob): string {
  switch (job.kind) {
    case "invite":
      return MAIL_KINDS.invite.subject(job.params)
    default:
      return MAIL_KINDS[job.kind].subject()
  }
}
