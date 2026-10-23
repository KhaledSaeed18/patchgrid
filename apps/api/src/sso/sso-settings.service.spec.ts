import type { Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, MemberActor } from "../auth/actor"
import type { StepUpService } from "../auth/mfa/step-up.service"
import type { RevocationEpochService } from "../auth/revocation/revocation-epoch.service"
import type { AuditEntry, AuditService } from "../audit/audit.service"
import { PermissionService } from "../authz/permission.service"
import { FixedClock } from "../common/clock/clock"
import {
  ConflictProblem,
  NotPermittedProblem,
  ServiceUnavailableProblem,
  StepUpRequiredProblem,
  ValidationProblem,
} from "../common/problems/problem.exception"
import { PublicUrls } from "../common/urls"
import type { AppConfig } from "../config/app-config"
import type { MembershipRepository } from "../memberships/repositories/membership.repository"
import type { RefreshTokenRepository } from "../platform/repositories/refresh-token.repository"
import type { PrismaService } from "../prisma/prisma.service"
import type { OrganizationLookupService } from "../tenancy/organization-lookup.service"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { DnsUnavailableError } from "./domain-resolver"
import { OidcRejectedError, OidcUnavailableError, type OidcClient } from "./oidc-client"
import type { OrgDomainRecord, OrgDomainRepository } from "./repositories/org-domain.repository"
import type { SsoConnectionRecord, SsoConnectionRepository } from "./repositories/sso-connection.repository"
import { SsoSecrets } from "./sso-secrets"
import { SsoSettingsService } from "./sso-settings.service"

const NOW = new Date("2026-10-23T12:00:00Z")
const KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
const ISSUER = "https://idp.acme.test/realms/acme"

type Options = { role?: Role; stepped?: boolean; org?: Partial<OrgDomainRecord>; connection?: Partial<SsoConnectionRecord> | null; txt?: string[] | Error; oidc?: Error; offDomain?: number }

function harness(options: Options = {}) {
  const secrets = new SsoSecrets({ SSO_SECRETS_KEY: KEY } as AppConfig)
  const org: OrgDomainRecord = {
    id: "o-1",
    slug: "acme",
    name: "Acme",
    status: "ACTIVE",
    domain: null,
    domainVerifiedAt: null,
    domainChallenge: null,
    requireSso: false,
    ...options.org,
  }
  let connection: SsoConnectionRecord | null =
    options.connection === null || options.connection === undefined
      ? null
      : {
          id: "c-1",
          orgId: "o-1",
          issuer: ISSUER,
          clientId: "patchgrid",
          clientSecretSealed: secrets.seal("stored-secret"),
          defaultRole: "REQUESTER",
          enabled: true,
          updatedAt: NOW,
          ...options.connection,
        }
  const audit: AuditEntry[] = []
  const domains = {
    find: vi.fn(async () => ({ ...org })),
    lock: vi.fn(async () => undefined),
    claim: vi.fn(async (_o: string, domain: string | null, challenge: string | null) => void Object.assign(org, { domain, domainChallenge: challenge, domainVerifiedAt: null })),
    markVerified: vi.fn(async (_o: string, domain: string, challenge: string, at: Date) => {
      if (org.domain !== domain || org.domainChallenge !== challenge || org.domainVerifiedAt !== null) return false
      Object.assign(org, { domainVerifiedAt: at, domainChallenge: null })
      return true
    }),
    setRequireSso: vi.fn(async (_o: string, required: boolean) => void (org.requireSso = required)),
  }
  const connections = {
    find: vi.fn(async () => connection),
    save: vi.fn(async (_o: string, data: Omit<SsoConnectionRecord, "id" | "orgId" | "updatedAt">) => {
      const issuerChanged = connection !== null && connection.issuer !== data.issuer
      connection = { id: "c-1", orgId: "o-1", updatedAt: NOW, ...data }
      return { record: connection, issuerChanged }
    }),
  }
  const oidc = { check: vi.fn(async () => (options.oidc === undefined ? undefined : Promise.reject(options.oidc))) }
  const dns = {
    txt: vi.fn(async () => {
      if (options.txt instanceof Error) throw options.txt
      return options.txt ?? []
    }),
  }
  const actor: MemberActor = { kind: "member", userId: "u-1", orgId: "o-1", membershipId: "m-1", role: options.role ?? "OWNER", teamIds: [], leadOfTeamIds: [] }
  const stepUp = {
    assert: vi.fn(() => {
      if (options.stepped === false) throw new StepUpRequiredProblem()
    }),
  }
  const lookup = { invalidate: vi.fn(async () => undefined) }
  const refreshTokens = { revokeSsoSessions: vi.fn(async () => ["u-7", "u-8"]) }
  const memberships = {
    idsForUsers: vi.fn(async (_o: string, users: string[]) => users.map((u) => `m-${u}`)),
    countOffDomain: vi.fn(async () => options.offDomain ?? 0),
  }
  const epochs = { bump: vi.fn(async (_membershipId: string) => undefined) }
  const service = new SsoSettingsService(
    domains as unknown as OrgDomainRepository,
    connections as unknown as SsoConnectionRepository,
    secrets,
    oidc as unknown as OidcClient,
    dns,
    new PermissionService(),
    stepUp as unknown as StepUpService,
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => "o-1" } as unknown as TenantContextService,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
    { record: async (_o: string, e: AuditEntry[]) => void audit.push(...e) } as unknown as AuditService,
    lookup as unknown as OrganizationLookupService,
    new PublicUrls({ ROOT_DOMAIN: "lvh.me", WEB_ORIGIN_PORTS: [3000, 3001], WEB_APP_PORT: 3001, PORT: 4000, isProduction: false } as AppConfig),
    refreshTokens as unknown as RefreshTokenRepository,
    memberships as unknown as MembershipRepository,
    epochs as unknown as RevocationEpochService,
    new FixedClock(NOW),
  )
  return { service, org, domains, connections: () => connection, oidc, dns, audit, lookup, secrets, stepUp, refreshTokens, epochs, memberships }
}

describe("SsoSettingsService: who", () => {
  it("is the owners' alone, every route", async () => {
    for (const role of ["REQUESTER", "AGENT", "ADMIN"] as const) {
      const h = harness({ role })
      await expect(h.service.get()).rejects.toBeInstanceOf(NotPermittedProblem)
      await expect(h.service.claimDomain({ domain: "acme.test" })).rejects.toBeInstanceOf(NotPermittedProblem)
      await expect(h.service.verifyDomain()).rejects.toBeInstanceOf(NotPermittedProblem)
      await expect(h.service.setRequirement({ required: true })).rejects.toBeInstanceOf(NotPermittedProblem)
    }
  })

  it("asks for a step-up before the connection or the requirement changes, and before anything is written", async () => {
    const h = harness({ stepped: false, org: { domain: "acme.test", domainVerifiedAt: NOW }, connection: {} })
    await expect(h.service.saveConnection({ issuer: ISSUER, clientId: "x", defaultRole: "AGENT", enabled: true })).rejects.toBeInstanceOf(StepUpRequiredProblem)
    await expect(h.service.setRequirement({ required: true })).rejects.toBeInstanceOf(StepUpRequiredProblem)
    expect(h.oidc.check).not.toHaveBeenCalled()
    expect(h.audit).toEqual([])
  })
})

describe("SsoSettingsService: the domain", () => {
  it("claims a domain with a fresh challenge and shows the record to publish", async () => {
    const h = harness()
    const settings = await h.service.claimDomain({ domain: "acme.test" })
    expect(settings.domain?.name).toBe("acme.test")
    expect(settings.domain?.verifiedAt).toBeNull()
    expect(settings.domain?.record?.name).toBe("_patchgrid-verify.acme.test")
    expect(settings.domain?.record?.value).toMatch(/^patchgrid-verify=[A-Za-z0-9_-]{43}$/)
    expect(h.audit.map((e) => e.action)).toEqual(["ORG_DOMAIN_CLAIMED"])
  })

  it("issues the challenge a domain claimed at signup never got", async () => {
    const h = harness({ org: { domain: "acme.test", domainChallenge: null } })
    const settings = await h.service.claimDomain({ domain: "acme.test" })
    expect(settings.domain?.record?.value).toMatch(/^patchgrid-verify=/)
  })

  it("does nothing for the domain already claimed, and removes one with null", async () => {
    const h = harness({ org: { domain: "acme.test", domainChallenge: "c" } })
    await h.service.claimDomain({ domain: "acme.test" })
    expect(h.domains.claim).not.toHaveBeenCalled()
    expect((await h.service.claimDomain({ domain: null })).domain).toBeNull()
    expect(h.audit.map((e) => e.action)).toEqual(["ORG_DOMAIN_REMOVED"])
  })

  it("will not move the domain from under a requirement", async () => {
    const h = harness({ org: { domain: "acme.test", domainVerifiedAt: NOW, requireSso: true } })
    await expect(h.service.claimDomain({ domain: "other.test" })).rejects.toBeInstanceOf(ConflictProblem)
    await expect(h.service.claimDomain({ domain: null })).rejects.toBeInstanceOf(ConflictProblem)
  })

  it("is proved by the TXT record that carries the challenge, and only that", async () => {
    const missing = harness({ org: { domain: "acme.test", domainChallenge: "abc" }, txt: ["patchgrid-verify=wrong", "v=spf1 -all"] })
    await expect(missing.service.verifyDomain()).rejects.toBeInstanceOf(ConflictProblem)
    expect(missing.dns.txt).toHaveBeenCalledWith("_patchgrid-verify.acme.test")

    const present = harness({ org: { domain: "acme.test", domainChallenge: "abc" }, txt: ["patchgrid-verify=abc"] })
    const settings = await present.service.verifyDomain()
    expect(settings.domain?.verifiedAt).toBe(NOW.toISOString())
    expect(settings.domain?.record).toBeNull()
    expect(present.audit.map((e) => e.action)).toEqual(["ORG_DOMAIN_VERIFIED"])
  })

  it("answers 503 when DNS cannot be asked, and 409 with nothing claimed", async () => {
    await expect(harness({ org: { domain: "acme.test", domainChallenge: "abc" }, txt: new DnsUnavailableError("ETIMEOUT") }).service.verifyDomain()).rejects.toBeInstanceOf(ServiceUnavailableProblem)
    await expect(harness().service.verifyDomain()).rejects.toBeInstanceOf(ConflictProblem)
  })

  it("lets the first workspace to prove a domain keep it", async () => {
    const h = harness({ org: { domain: "acme.test", domainChallenge: "abc" }, txt: ["patchgrid-verify=abc"] })
    h.domains.markVerified.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
    await expect(h.service.verifyDomain()).rejects.toThrow(/already proved/)
  })
})

describe("SsoSettingsService: the connection", () => {
  it("needs a secret the first time, then keeps the stored one when none is sent", async () => {
    const first = harness()
    await expect(first.service.saveConnection({ issuer: ISSUER, clientId: "patchgrid", defaultRole: "REQUESTER", enabled: true })).rejects.toBeInstanceOf(ValidationProblem)

    const again = harness({ connection: {} })
    const before = again.connections()?.clientSecretSealed
    const settings = await again.service.saveConnection({ issuer: ISSUER, clientId: "patchgrid", defaultRole: "AGENT", enabled: true })
    expect(again.connections()?.clientSecretSealed).toBe(before)
    expect(again.oidc.check).toHaveBeenCalledWith({ issuer: ISSUER, clientId: "patchgrid", clientSecret: "stored-secret" })
    expect(settings.connection).toMatchObject({ clientSecretSet: true, defaultRole: "AGENT" })
    expect(JSON.stringify(settings)).not.toContain("stored-secret")
  })

  it("seals a new secret and audits that it was replaced, never what it is", async () => {
    const h = harness()
    await h.service.saveConnection({ issuer: ISSUER, clientId: "patchgrid", clientSecret: "brand-new", defaultRole: "REQUESTER", enabled: true })
    expect(h.secrets.open(h.connections()?.clientSecretSealed ?? "")).toBe("brand-new")
    expect(h.audit).toHaveLength(1)
    expect(h.audit[0]?.diff).toMatchObject({ clientSecretReplaced: true, issuer: { from: null, to: ISSUER } })
    expect(JSON.stringify(h.audit)).not.toContain("brand-new")
  })

  it("refuses an issuer discovery cannot use, saying which way it failed", async () => {
    const rejected = harness({ oidc: new OidcRejectedError("issuer mismatch") })
    await expect(rejected.service.saveConnection({ issuer: ISSUER, clientId: "x", clientSecret: "s", defaultRole: "REQUESTER", enabled: true })).rejects.toThrow(ValidationProblem)
    const down = harness({ oidc: new OidcUnavailableError("discovery") })
    await expect(down.service.saveConnection({ issuer: ISSUER, clientId: "x", clientSecret: "s", defaultRole: "REQUESTER", enabled: true })).rejects.toThrow(ValidationProblem)
    expect(rejected.audit).toEqual([])
  })

  it("will not disable the connection a requirement depends on", async () => {
    const h = harness({ org: { domain: "acme.test", domainVerifiedAt: NOW, requireSso: true }, connection: {} })
    await expect(h.service.saveConnection({ issuer: ISSUER, clientId: "patchgrid", defaultRole: "REQUESTER", enabled: false })).rejects.toBeInstanceOf(ConflictProblem)
  })

  it("will not hand the stored secret to a new issuer or client", async () => {
    const h = harness({ connection: {} })
    await expect(h.service.saveConnection({ issuer: "https://idp.other.test/", clientId: "patchgrid", defaultRole: "REQUESTER", enabled: true })).rejects.toBeInstanceOf(ValidationProblem)
    await expect(h.service.saveConnection({ issuer: ISSUER, clientId: "another", defaultRole: "REQUESTER", enabled: true })).rejects.toBeInstanceOf(ValidationProblem)
    expect(h.oidc.check).not.toHaveBeenCalled()
  })

  it("ends every session a replaced issuer started, and records that its identities were unlinked", async () => {
    const h = harness({ connection: {} })
    await h.service.saveConnection({ issuer: "https://idp.other.test/", clientId: "patchgrid", clientSecret: "new-one", defaultRole: "REQUESTER", enabled: true })
    expect(h.audit[0]?.diff).toMatchObject({ identitiesUnlinked: true })
    expect(h.refreshTokens.revokeSsoSessions).toHaveBeenCalledWith("o-1", NOW)
    expect(h.epochs.bump.mock.calls.map(([id]) => id)).toEqual(["m-u-7", "m-u-8"])
  })

  it("ends them when the connection is switched off, and not when it is merely saved again", async () => {
    const off = harness({ connection: {} })
    await off.service.saveConnection({ issuer: ISSUER, clientId: "patchgrid", defaultRole: "REQUESTER", enabled: false })
    expect(off.refreshTokens.revokeSsoSessions).toHaveBeenCalled()
    const same = harness({ connection: {} })
    await same.service.saveConnection({ issuer: ISSUER, clientId: "patchgrid", defaultRole: "AGENT", enabled: true })
    expect(same.refreshTokens.revokeSsoSessions).not.toHaveBeenCalled()
    expect(same.epochs.bump).not.toHaveBeenCalled()
  })
})

describe("SsoSettingsService: the requirement", () => {
  it("needs a proved domain and an enabled connection first", async () => {
    await expect(harness({ connection: {} }).service.setRequirement({ required: true })).rejects.toThrow(/Prove/)
    await expect(harness({ org: { domain: "acme.test", domainVerifiedAt: NOW }, connection: { enabled: false } }).service.setRequirement({ required: true })).rejects.toThrow(/Enable/)
  })

  it("asks for confirmation when members below owner have addresses off the domain", async () => {
    const h = harness({ org: { domain: "acme.test", domainVerifiedAt: NOW }, connection: {}, offDomain: 3 })
    await expect(h.service.setRequirement({ required: true })).rejects.toThrow(/3 members below owner/)
    expect(h.audit).toEqual([])
    expect((await h.service.setRequirement({ required: true, confirm: true })).required).toBe(true)
  })

  it("turns on, is audited, and drops the cached summary open and refresh read it from", async () => {
    const h = harness({ org: { domain: "acme.test", domainVerifiedAt: NOW }, connection: {} })
    expect((await h.service.setRequirement({ required: true })).required).toBe(true)
    expect(h.audit.map((e) => e.action)).toEqual(["ORG_SSO_REQUIREMENT_CHANGED"])
    expect(h.lookup.invalidate).toHaveBeenCalledWith({ id: "o-1", slug: "acme" })
  })

  it("says the redirect URI every workspace registers", async () => {
    expect((await harness().service.get()).redirectUri).toBe("http://api.lvh.me:4000/api/v1/auth/sso/callback")
  })
})
