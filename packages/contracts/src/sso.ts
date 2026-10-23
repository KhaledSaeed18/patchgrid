import { z } from "zod"

import { emailSchema } from "./auth.ts"
import { emailDomainSchema } from "./organizations.ts"
import { slugSchema } from "./slug.ts"

/**
 * Per-tenant single sign-on (ADR-0054): the workspace's proved email domain,
 * its one OpenID Connect connection, and the browser's way in and out of the
 * identity provider.
 */

/**
 * Mail providers anyone can sign up at. They cannot be DNS-proved by a
 * workspace in practice; refusing them up front documents the intent and
 * guards against a verification bug (TENANCY.md §5).
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "126.com",
  "163.com",
  "aol.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "tutanota.com",
  "yahoo.com",
  "yandex.com",
  "yandex.ru",
  "ymail.com",
  "zoho.com",
])

/** The TXT record that proves a domain: its name… */
export const domainProofRecordName = (domain: string): string => `_patchgrid-verify.${domain}`
/** …and its value. */
export const domainProofRecordValue = (challenge: string): string => `patchgrid-verify=${challenge}`

/** `PUT /org/domain`: claim a domain (unproved until verified), or `null` to remove it. */
export const orgDomainRequestSchema = z.strictObject({
  domain: emailDomainSchema
    .refine((domain) => !FREE_MAIL_DOMAINS.has(domain), { error: "is a public mail provider, which no workspace can claim" })
    .nullable(),
})
export type OrgDomainRequest = z.infer<typeof orgDomainRequestSchema>

/** A person provisioned by SSO joins at one of these, never above (a CHECK says so too). */
export const ssoDefaultRoleSchema = z.enum(["REQUESTER", "AGENT"])
export type SsoDefaultRole = z.infer<typeof ssoDefaultRoleSchema>

/**
 * `PUT /org/sso/connection`. The secret is write-only: omitted, the stored one
 * stands; the API never returns it. Saving runs discovery against the issuer.
 */
export const ssoConnectionRequestSchema = z.strictObject({
  issuer: z.url({ protocol: /^https?$/, error: "must be the issuer's URL" }).max(512),
  clientId: z.string().trim().min(1).max(255),
  clientSecret: z.string().min(1).max(512).optional(),
  defaultRole: ssoDefaultRoleSchema,
  enabled: z.boolean(),
})
export type SsoConnectionRequest = z.infer<typeof ssoConnectionRequestSchema>

/**
 * `PUT /org/sso/requirement`: "SSO required", which mirrors `requireMfa` and
 * spares owners. Turning it on while members below owner have addresses off
 * the domain — whom no provider of this workspace can vouch for — is a `409`
 * the owner retries with `confirm: true` (M13 review).
 */
/**
 * `PUT /org/domain/join` (TENANCY.md §5): letting anyone with a verified
 * address at the proved domain join, at `REQUESTER` or `AGENT`. A step-up
 * action, as the SSO connection is: it opens the workspace to a whole domain.
 */
export const domainJoinRequestSchema = z.strictObject({ enabled: z.boolean(), role: ssoDefaultRoleSchema })
export type DomainJoinRequest = z.infer<typeof domainJoinRequestSchema>

export const ssoRequirementRequestSchema = z.strictObject({ required: z.boolean(), confirm: z.boolean().optional() })
export type SsoRequirementRequest = z.infer<typeof ssoRequirementRequestSchema>

/** `GET /org/sso`: everything the settings page shows, the secret excepted. */
export const ssoSettingsSchema = z.object({
  /** Register this at the identity provider: the one callback every workspace shares. */
  redirectUri: z.url(),
  domain: z
    .object({
      name: z.string(),
      verifiedAt: z.iso.datetime().nullable(),
      /** The TXT record to publish; `null` once verified. */
      record: z.object({ name: z.string(), value: z.string() }).nullable(),
      /** Whether a verified address at the proved domain may join on its own, and at which role (TENANCY.md §5). */
      join: z.object({ enabled: z.boolean(), role: ssoDefaultRoleSchema }),
    })
    .nullable(),
  connection: z
    .object({
      issuer: z.string(),
      clientId: z.string(),
      clientSecretSet: z.boolean(),
      defaultRole: ssoDefaultRoleSchema,
      enabled: z.boolean(),
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
  required: z.boolean(),
})
export type SsoSettings = z.infer<typeof ssoSettingsSchema>

/** `POST /auth/sso/discover`: does this address's domain sign in through a workspace's IdP? A fact about a domain, never an account. */
export const ssoDiscoverRequestSchema = z.strictObject({ email: emailSchema })
export const ssoDiscoverResponseSchema = z.object({ sso: z.object({ slug: slugSchema, name: z.string() }).nullable() })
export type SsoDiscoverResponse = z.infer<typeof ssoDiscoverResponseSchema>

/** Signing in, or re-proving for step-up with a fresh authentication at the IdP. */
export const ssoIntentSchema = z.enum(["sign-in", "step-up"])
export type SsoIntent = z.infer<typeof ssoIntentSchema>

/** A path on the workspace host to land on afterwards: same-host only, never `//` or a backslash. */
export const ssoReturnPathSchema = z
  .string()
  .max(512)
  .regex(/^\/(?![/\\])[^\\\s]*$/, { error: "must be a path on the workspace" })

/** `GET /auth/sso/start`: the workspace by slug or by the person's email, exactly one. */
export const ssoStartQuerySchema = z
  .object({
    email: emailSchema.optional(),
    slug: slugSchema.optional(),
    intent: ssoIntentSchema.default("sign-in"),
    next: ssoReturnPathSchema.optional(),
  })
  .refine((v) => (v.email === undefined) !== (v.slug === undefined), { error: "send an email or a workspace" })
  .refine((v) => v.intent === "sign-in" || v.slug !== undefined, { error: "step-up names its workspace" })
export type SsoStartQuery = z.infer<typeof ssoStartQuerySchema>

/**
 * Why a sign-in came back to the login page (`?sso=<code>`). A fixed set: an
 * identity provider's own words are never shown.
 */
export const SSO_ERROR_CODES = [
  /** No workspace with an enabled connection for that domain or slug. */
  "not-configured",
  /** The identity provider could not be reached or answered nonsense. */
  "unavailable",
  /** The identity provider refused, or the person cancelled. */
  "denied",
  /** The flow expired, was used, or came back to a different browser. */
  "expired",
  /** The address is unverified, or not at the workspace's proved domain. */
  "email",
  /** The membership is disabled or removed, or the account erased. */
  "inactive",
  /** Provisioning would exceed the plan's seats. */
  "seat",
  /** Step-up came back as someone other than the signed-in person, or with no session. */
  "mismatch",
  /** Step-up came back without a fresh authentication. */
  "stale",
  /** An owner tried to step up at the provider: owners re-prove with their own credentials (M13 review). */
  "owner",
  /** The round trip was started from another site, not from Patchgrid's own pages (M13 review). */
  "foreign",
] as const
export const ssoErrorCodeSchema = z.enum(SSO_ERROR_CODES)
export type SsoErrorCode = z.infer<typeof ssoErrorCodeSchema>
