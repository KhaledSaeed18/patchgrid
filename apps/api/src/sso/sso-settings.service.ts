import { Injectable } from "@nestjs/common"
import {
  domainProofRecordName,
  domainProofRecordValue,
  type OrgDomainRequest,
  type SsoConnectionRequest,
  type SsoRequirementRequest,
  type SsoSettings,
} from "@patchgrid/contracts"
import { randomBytes } from "node:crypto"

import { ActorService } from "../auth/actor"
import { StepUpService } from "../auth/mfa/step-up.service"
import { RevocationEpochService } from "../auth/revocation/revocation-epoch.service"
import { AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import { ConflictProblem, NotFoundProblem, ServiceUnavailableProblem, ValidationProblem } from "../common/problems/problem.exception"
import { PublicUrls } from "../common/urls"
import { MembershipRepository } from "../memberships/repositories/membership.repository"
import { RefreshTokenRepository } from "../platform/repositories/refresh-token.repository"
import { PrismaService } from "../prisma/prisma.service"
import { OrganizationLookupService } from "../tenancy/organization-lookup.service"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { DnsUnavailableError, type DomainResolver, InjectDomainResolver } from "./domain-resolver"
import { OidcClient, OidcRejectedError } from "./oidc-client"
import { OrgDomainRepository } from "./repositories/org-domain.repository"
import { type SsoConnectionRecord, SsoConnectionRepository } from "./repositories/sso-connection.repository"
import { SsoSecrets } from "./sso-secrets"

/**
 * A workspace's SSO settings (ADR-0054): its email domain and the DNS proof
 * of it, its one OpenID Connect connection, and "SSO required".
 *
 * All owner-only. The connection and the requirement also take a step-up:
 * whoever controls them can sign in as anyone at the domain, owners
 * included. The domain needs no step-up — proving it needs its DNS, which no
 * stolen cookie gives.
 */
@Injectable()
export class SsoSettingsService {
  constructor(
    private readonly domains: OrgDomainRepository,
    private readonly connections: SsoConnectionRepository,
    private readonly secrets: SsoSecrets,
    private readonly oidc: OidcClient,
    @InjectDomainResolver() private readonly dns: DomainResolver,
    private readonly permissions: PermissionService,
    private readonly stepUp: StepUpService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly lookup: OrganizationLookupService,
    private readonly urls: PublicUrls,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly memberships: MembershipRepository,
    private readonly epochs: RevocationEpochService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async get(): Promise<SsoSettings> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:manage_sso")
    return this.read(this.tenant.requireOrgId())
  }

  /** Claims a domain, unproved, with a fresh challenge — or removes it. Never while SSO is required. */
  async claimDomain(request: OrgDomainRequest): Promise<SsoSettings> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:manage_domain")
    const orgId = this.tenant.requireOrgId()
    await this.prisma.transaction(async () => {
      await this.domains.lock(orgId)
      const current = await this.domains.find(orgId)
      if (current === null) throw new NotFoundProblem()
      // The same domain, still unproved and with no challenge (claimed at signup): issue the challenge it never got.
      if (request.domain !== null && request.domain === current.domain && current.domainVerifiedAt === null && current.domainChallenge === null) {
        await this.domains.claim(orgId, request.domain, randomBytes(32).toString("base64url"))
        return
      }
      if (request.domain === current.domain) return
      // Sign-in is routed by the proved domain; changing it under a requirement would strand every member.
      if (current.requireSso) throw new ConflictProblem("Turn off the SSO requirement before changing the domain")
      const challenge = request.domain === null ? null : randomBytes(32).toString("base64url")
      await this.domains.claim(orgId, request.domain, challenge)
      await this.audit.record(orgId, [
        {
          action: request.domain === null ? "ORG_DOMAIN_REMOVED" : "ORG_DOMAIN_CLAIMED",
          entityType: "Organization",
          entityId: orgId,
          diff: { domain: { from: current.domain, to: request.domain } },
        },
      ])
    })
    return this.read(orgId)
  }

  /**
   * Looks the TXT record up and, when it carries the challenge, marks the
   * domain proved. First verified wins: the partial unique index refuses a
   * second workspace, which gets a `409`, not a silent second claim.
   */
  async verifyDomain(): Promise<SsoSettings> {
    this.permissions.assert(this.actors.requireTenantActor(), "org:manage_domain")
    const orgId = this.tenant.requireOrgId()
    const current = await this.domains.find(orgId)
    if (current === null) throw new NotFoundProblem()
    if (current.domain === null || current.domainChallenge === null) {
      if (current.domainVerifiedAt !== null) return this.read(orgId)
      throw new ConflictProblem("Claim a domain first")
    }
    let records: string[]
    try {
      records = await this.dns.txt(domainProofRecordName(current.domain))
    } catch (error) {
      if (error instanceof DnsUnavailableError) throw new ServiceUnavailableProblem("DNS could not be asked just now; try again shortly")
      throw error
    }
    if (!records.includes(domainProofRecordValue(current.domainChallenge))) {
      throw new ConflictProblem(`No TXT record at ${domainProofRecordName(current.domain)} carries this workspace's value yet; DNS can take a while`)
    }
    const domain = current.domain
    const challenge = current.domainChallenge
    await this.prisma.transaction(async () => {
      let verified: boolean
      try {
        verified = await this.domains.markVerified(orgId, domain, challenge, this.clock.now())
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictProblem("Another workspace has already proved this domain")
        throw error
      }
      if (!verified) throw new ConflictProblem("The domain changed while it was being checked; check again")
      await this.audit.record(orgId, [{ action: "ORG_DOMAIN_VERIFIED", entityType: "Organization", entityId: orgId, diff: { domain } }])
    })
    return this.read(orgId)
  }

  /**
   * Creates or replaces the connection, after discovery against the issuer
   * proves it is an OpenID provider that names itself as configured. The
   * secret is write-only; omitted, the stored one stands.
   */
  async saveConnection(request: SsoConnectionRequest): Promise<SsoSettings> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "org:manage_sso")
    this.stepUp.assert(actor)
    const orgId = this.tenant.requireOrgId()
    const [existing, org] = await Promise.all([this.connections.find(orgId), this.domains.find(orgId)])
    if (org === null) throw new NotFoundProblem()
    // The stored secret is for the provider it was given to: a new issuer or client gets a new one, or it
    // would be presented to whatever host the new issuer names (M13 review).
    const sameClient = existing !== null && existing.issuer === request.issuer && existing.clientId === request.clientId
    const clientSecret = request.clientSecret ?? (sameClient ? this.secrets.open(existing.clientSecretSealed) : null)
    if (clientSecret === null) {
      throw new ValidationProblem([{ path: "clientSecret", message: existing === null ? "is required" : "is required for a new issuer or client", code: "required" }])
    }
    if (!request.enabled && org.requireSso) throw new ConflictProblem("Turn off the SSO requirement before disabling the connection")

    try {
      await this.oidc.check({ issuer: request.issuer, clientId: request.clientId, clientSecret })
    } catch (error) {
      const message = error instanceof OidcRejectedError ? "is not an OpenID provider that answers as this issuer" : "could not be reached"
      throw new ValidationProblem([{ path: "issuer", message, code: "issuer_unusable" }])
    }

    const ended = await this.prisma.transaction(async () => {
      await this.domains.lock(orgId)
      if (!request.enabled && (await this.domains.find(orgId))?.requireSso === true) {
        throw new ConflictProblem("Turn off the SSO requirement before disabling the connection")
      }
      const { issuerChanged } = await this.connections.save(orgId, {
        issuer: request.issuer,
        clientId: request.clientId,
        clientSecretSealed: request.clientSecret === undefined && existing !== null ? existing.clientSecretSealed : this.secrets.seal(clientSecret),
        defaultRole: request.defaultRole,
        enabled: request.enabled,
      })
      await this.audit.record(orgId, [
        {
          action: "SSO_CONNECTION_SAVED",
          entityType: "Organization",
          entityId: orgId,
          diff: connectionDiff(existing, request, issuerChanged),
        },
      ])
      // A provider switched off or replaced vouches for nobody any more: its sessions end with it (M13 review).
      const withdrawn = existing !== null && ((existing.enabled && !request.enabled) || issuerChanged)
      if (!withdrawn) return []
      const people = await this.refreshTokens.revokeSsoSessions(orgId, this.clock.now())
      return this.memberships.idsForUsers(orgId, people)
    })
    // The access tokens those sessions minted die now, not in fifteen minutes; after commit, as every epoch bump is.
    for (const membershipId of ended) await this.epochs.bump(membershipId)
    return this.read(orgId)
  }

  /** "SSO required": only with a proved domain and an enabled connection, so there is somewhere to send people. */
  async setRequirement(request: SsoRequirementRequest): Promise<SsoSettings> {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, "org:manage_sso")
    this.stepUp.assert(actor)
    const orgId = this.tenant.requireOrgId()
    const slug = await this.prisma.transaction(async () => {
      await this.domains.lock(orgId)
      const org = await this.domains.find(orgId)
      if (org === null) throw new NotFoundProblem()
      if (org.requireSso === request.required) return org.slug
      if (request.required) {
        const connection = await this.connections.find(orgId)
        if (org.domainVerifiedAt === null || org.domain === null) throw new ConflictProblem("Prove the workspace's domain before requiring SSO")
        if (connection?.enabled !== true) throw new ConflictProblem("Enable the SSO connection before requiring it")
        // A soft block: say who would be shut out, and go ahead only when the owner confirms it.
        const outside = await this.memberships.countOffDomain(orgId, org.domain)
        if (outside > 0 && request.confirm !== true) {
          throw new ConflictProblem(
            `${String(outside)} ${outside === 1 ? "member below owner has an address" : "members below owner have addresses"} outside ${org.domain}. The identity provider cannot sign them in, so requiring SSO shuts them out. Send confirm to require it anyway.`,
          )
        }
      }
      await this.domains.setRequireSso(orgId, request.required)
      await this.audit.record(orgId, [
        {
          action: "ORG_SSO_REQUIREMENT_CHANGED",
          entityType: "Organization",
          entityId: orgId,
          diff: { requireSso: { from: org.requireSso, to: request.required } },
        },
      ])
      return org.slug
    })
    // Open and refresh read the requirement from the cached summary.
    await this.lookup.invalidate({ id: orgId, slug })
    return this.read(orgId)
  }

  private async read(orgId: string): Promise<SsoSettings> {
    const [org, connection] = await Promise.all([this.domains.find(orgId), this.connections.find(orgId)])
    if (org === null) throw new NotFoundProblem()
    return {
      redirectUri: this.urls.ssoCallback(),
      domain:
        org.domain === null
          ? null
          : {
              name: org.domain,
              verifiedAt: org.domainVerifiedAt?.toISOString() ?? null,
              record:
                org.domainVerifiedAt === null && org.domainChallenge !== null
                  ? { name: domainProofRecordName(org.domain), value: domainProofRecordValue(org.domainChallenge) }
                  : null,
            },
      connection:
        connection === null
          ? null
          : {
              issuer: connection.issuer,
              clientId: connection.clientId,
              clientSecretSet: true,
              defaultRole: connection.defaultRole,
              enabled: connection.enabled,
              updatedAt: connection.updatedAt.toISOString(),
            },
      required: org.requireSso,
    }
  }
}

/** What changed, never the secret: only whether it was replaced. */
function connectionDiff(before: SsoConnectionRecord | null, after: SsoConnectionRequest, issuerChanged: boolean): Record<string, unknown> {
  const diff: Record<string, unknown> = {}
  const fields = ["issuer", "clientId", "defaultRole", "enabled"] as const
  for (const field of fields) {
    if (before === null || before[field] !== after[field]) diff[field] = { from: before?.[field] ?? null, to: after[field] }
  }
  if (after.clientSecret !== undefined) diff.clientSecretReplaced = true
  if (issuerChanged) diff.identitiesUnlinked = true
  return diff
}

/** Prisma's P2002, recognised by its code so this file need not import the runtime error class. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "P2002"
}
