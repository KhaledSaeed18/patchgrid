import { describe, expect, it, vi } from "vitest"

import { FixedClock } from "../../common/clock/clock"
import { PublicUrls } from "../../common/urls"
import type { AppConfig } from "../../config/app-config"
import { type OidcClient, OidcRejectedError, OidcUnavailableError, type VerifiedIdentity } from "../../sso/oidc-client"
import type { OrgDomainRecord, OrgDomainRepository } from "../../sso/repositories/org-domain.repository"
import type { SsoConnectionRecord, SsoConnectionRepository } from "../../sso/repositories/sso-connection.repository"
import { SsoSecrets } from "../../sso/sso-secrets"
import type { OrganizationLookup } from "../../tenancy/organization-lookup"
import { CookieService } from "../cookies"
import type { SessionService } from "../sessions/session.service"
import type { SsoFlow, SsoFlowStore } from "./sso-flow-store"
import { SsoFailure, type SsoProvisioning } from "./sso-provisioning"
import { SsoSignInService } from "./sso-sign-in.service"

const NOW = new Date("2026-10-23T12:00:00Z")
const NOW_S = Math.floor(NOW.getTime() / 1000)
const KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
const ORG_ID = "0190b2f0-0000-7000-8000-00000000000a"
const CONN_ID = "0190b2f0-0000-7000-8000-0000000000c1"
const USER = "0190b2f0-0000-7000-8000-000000000001"
const client = { userAgent: "vitest", ip: "127.0.0.1" }
const callbackUrl = new URL("http://api.lvh.me:4000/api/v1/auth/sso/callback?code=c&state=s")

type Options = { org?: Partial<OrgDomainRecord> | null; connection?: Partial<SsoConnectionRecord> | null; identity?: Partial<VerifiedIdentity>; exchange?: Error; flow?: Partial<SsoFlow> | null; pgId?: { userId: string; ssoOrgId: string | null } | null }

function harness(options: Options = {}) {
  const config = { SSO_SECRETS_KEY: KEY, ROOT_DOMAIN: "lvh.me", WEB_ORIGIN_PORTS: [3000, 3001], WEB_APP_PORT: 3001, PORT: 4000, isProduction: false, COOKIE_DOMAIN: ".lvh.me" } as AppConfig
  const secrets = new SsoSecrets(config)
  const org: OrgDomainRecord | null =
    options.org === null ? null : { id: ORG_ID, slug: "acme", name: "Acme", status: "ACTIVE", domain: "acme.test", domainVerifiedAt: NOW, domainChallenge: null, requireSso: false, ...options.org }
  const connection: SsoConnectionRecord | null =
    options.connection === null
      ? null
      : { id: CONN_ID, orgId: ORG_ID, issuer: "https://idp.acme.test", clientId: "patchgrid", clientSecretSealed: secrets.seal("s3cret"), defaultRole: "REQUESTER", enabled: true, updatedAt: NOW, ...options.connection }
  const domains = {
    find: vi.fn(async () => org),
    findByVerifiedDomain: vi.fn(async (domain: string) => (org?.domain === domain && org.domainVerifiedAt !== null ? org : null)),
  }
  const connections = { find: vi.fn(async () => connection) }
  const oidc = {
    configuration: vi.fn(async () => ({})),
    authorizationUrl: vi.fn((_c: unknown, p: Record<string, unknown>) => {
      const url = new URL("https://idp.acme.test/auth")
      for (const [k, v] of Object.entries(p)) url.searchParams.set(k, String(v))
      return url
    }),
    exchange: vi.fn(async () => {
      if (options.exchange !== undefined) throw options.exchange
      return { subject: "sub-1", email: "kim@acme.test", emailVerified: true, name: "Kim", authTime: NOW_S, ...options.identity }
    }),
  }
  const stored = new Map<string, SsoFlow>()
  const defaultFlow: SsoFlow = { orgId: ORG_ID, connectionId: CONN_ID, codeVerifier: "v".repeat(43), nonce: "n".repeat(22), intent: "sign-in", next: "/queues", startedAt: NOW_S - 30 }
  if (options.flow !== null) stored.set("s", { ...defaultFlow, ...options.flow })
  const flows = {
    put: vi.fn(async (state: string, flow: SsoFlow) => void stored.set(state, flow)),
    take: vi.fn(async (state: string) => {
      const flow = stored.get(state) ?? null
      stored.delete(state)
      return flow
    }),
  }
  const provisioning = { resolve: vi.fn(async () => ({ account: { id: USER, email: "kim@acme.test", name: "Kim", passwordHash: null, emailVerifiedAt: NOW, anonymisedAt: null }, membershipId: "m-1" })) }
  const sessions = {
    startIdentity: vi.fn(async () => ({ response: { session: { slug: "acme" } }, cookies: [{ name: "pg_id", value: "x", path: "/", maxAgeSeconds: 1 }] })),
    identityFor: vi.fn(async () => (options.pgId === undefined ? { userId: USER, ssoOrgId: ORG_ID } : options.pgId)),
    open: vi.fn(async () => [{ name: "pg_at_acme", value: "x", path: "/", maxAgeSeconds: 1 }]),
  }
  const lookup = { bySlug: vi.fn(async (slug: string) => (slug === "acme" && org !== null ? { id: org.id } : null)), byId: vi.fn(async () => ({ slug: "acme" })) }
  const service = new SsoSignInService(
    domains as unknown as OrgDomainRepository,
    connections as unknown as SsoConnectionRepository,
    secrets,
    oidc as unknown as OidcClient,
    flows as unknown as SsoFlowStore,
    provisioning as unknown as SsoProvisioning,
    sessions as unknown as SessionService,
    new CookieService(config),
    new PublicUrls(config),
    lookup as unknown as OrganizationLookup,
    new FixedClock(NOW),
  )
  return { service, oidc, flows, stored, provisioning, sessions }
}

async function failure(promise: Promise<unknown>): Promise<SsoFailure> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  if (!(error instanceof SsoFailure)) throw new Error(`expected an SsoFailure, got ${String(error)}`)
  return error
}

describe("SsoSignInService.discover", () => {
  it("names the workspace for an address at a proved domain with an enabled connection", async () => {
    expect(await harness().service.discover("kim@acme.test")).toEqual({ sso: { slug: "acme", name: "Acme" } })
  })

  it("says nothing for any other domain, an unproved one, or a disabled connection", async () => {
    expect((await harness().service.discover("kim@other.test")).sso).toBeNull()
    expect((await harness({ org: { domainVerifiedAt: null } }).service.discover("kim@acme.test")).sso).toBeNull()
    expect((await harness({ connection: { enabled: false } }).service.discover("kim@acme.test")).sso).toBeNull()
  })
})

describe("SsoSignInService.start", () => {
  it("sends the browser to the provider with PKCE, a state and a nonce, and keeps the state in its cookie", async () => {
    const h = harness({ flow: null })
    const { location, cookies } = await h.service.start({ email: "kim@acme.test", intent: "sign-in", next: "/queues" })
    const url = new URL(location)
    const state = url.searchParams.get("state") ?? ""
    expect(url.searchParams.get("codeChallenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get("nonce")).toBe(h.stored.get(state)?.nonce)
    expect(url.searchParams.get("redirectUri")).toBe("http://api.lvh.me:4000/api/v1/auth/sso/callback")
    expect(url.searchParams.get("loginHint")).toBe("kim@acme.test")
    expect(url.searchParams.get("reauthenticate")).toBe("false")
    expect(cookies).toEqual([{ name: "pg_sso", value: state, path: "/api/v1/auth/sso", maxAgeSeconds: 600 }])
    expect(h.stored.get(state)).toMatchObject({ orgId: ORG_ID, connectionId: CONN_ID, intent: "sign-in", next: "/queues", startedAt: NOW_S })
    // The challenge is derived from the verifier; the verifier itself never leaves the server.
    expect(location).not.toContain(h.stored.get(state)?.codeVerifier ?? "-")
  })

  it("asks for a fresh authentication on step-up", async () => {
    const { location } = await harness({ flow: null }).service.start({ slug: "acme", intent: "step-up" })
    expect(new URL(location).searchParams.get("reauthenticate")).toBe("true")
  })

  it("refuses a workspace with nothing to route to, and sends a step-up's failure back to the workspace", async () => {
    expect((await failure(harness({ connection: null }).service.start({ email: "kim@acme.test", intent: "sign-in" }))).code).toBe("not-configured")
    const stepUp = await failure(harness({ connection: { enabled: false } }).service.start({ slug: "acme", intent: "step-up" }))
    expect(stepUp.slug).toBe("acme")
  })

  it("is unavailable when the provider cannot be discovered", async () => {
    const h = harness()
    h.oidc.configuration.mockRejectedValueOnce(new OidcUnavailableError("discovery"))
    expect((await failure(h.service.start({ email: "kim@acme.test", intent: "sign-in" }))).code).toBe("unavailable")
  })
})

describe("SsoSignInService.callback", () => {
  const params = { code: "c", state: "s" }

  it("signs in: a session scoped to this workspace, landing where the person was going", async () => {
    const h = harness()
    const result = await h.service.callback(params, callbackUrl, "s", undefined, client)
    expect(h.sessions.startIdentity).toHaveBeenCalledWith(expect.objectContaining({ id: USER }), client, "acme", ORG_ID)
    expect(result.location).toBe("http://acme.lvh.me:3001/queues")
    expect(h.provisioning.resolve).toHaveBeenCalledWith(expect.objectContaining({ id: ORG_ID }), expect.objectContaining({ id: CONN_ID }), { subject: "sub-1", email: "kim@acme.test", name: "Kim" })
  })

  it("accepts the callback only in the browser that started it, and only once", async () => {
    expect((await failure(harness().service.callback(params, callbackUrl, "other", undefined, client))).code).toBe("expired")
    expect((await failure(harness().service.callback(params, callbackUrl, undefined, undefined, client))).code).toBe("expired")
    const h = harness()
    await h.service.callback(params, callbackUrl, "s", undefined, client)
    expect((await failure(h.service.callback(params, callbackUrl, "s", undefined, client))).code).toBe("expired")
  })

  it("spends the flow even when the provider said no", async () => {
    const h = harness()
    expect((await failure(h.service.callback({ state: "s", error: "access_denied" }, callbackUrl, "s", undefined, client))).code).toBe("denied")
    expect(h.stored.size).toBe(0)
  })

  it("trusts an address only when verified and at the workspace's proved domain", async () => {
    expect((await failure(harness({ identity: { emailVerified: false } }).service.callback(params, callbackUrl, "s", undefined, client))).code).toBe("email")
    expect((await failure(harness({ identity: { email: "kim@evil.test" } }).service.callback(params, callbackUrl, "s", undefined, client))).code).toBe("email")
    expect((await failure(harness({ identity: { email: null } }).service.callback(params, callbackUrl, "s", undefined, client))).code).toBe("email")
  })

  it("tells a failed check from an unreachable provider", async () => {
    expect((await failure(harness({ exchange: new OidcRejectedError("nonce") }).service.callback(params, callbackUrl, "s", undefined, client))).code).toBe("denied")
    expect((await failure(harness({ exchange: new OidcUnavailableError("token") }).service.callback(params, callbackUrl, "s", undefined, client))).code).toBe("unavailable")
  })

  it("ends the flight when the connection was replaced or disabled meanwhile", async () => {
    expect((await failure(harness({ connection: { id: "0190b2f0-0000-7000-8000-0000000000c2" } }).service.callback(params, callbackUrl, "s", undefined, client))).code).toBe("not-configured")
    expect((await failure(harness({ connection: { enabled: false } }).service.callback(params, callbackUrl, "s", undefined, client))).code).toBe("not-configured")
  })

  describe("step-up", () => {
    const stepUp = { intent: "step-up" as const, startedAt: NOW_S - 30 }

    it("re-issues the pair with the proof, keeping the session's scope", async () => {
      const h = harness({ flow: stepUp })
      const result = await h.service.callback(params, callbackUrl, "s", "pg-id", client)
      expect(h.sessions.open).toHaveBeenCalledWith(USER, "acme", client, { stepUpAt: NOW, ssoOrgId: ORG_ID })
      expect(h.provisioning.resolve).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), false)
      expect(result.location).toBe("http://acme.lvh.me:3001/queues")
    })

    it("refuses an authentication older than the flow", async () => {
      const stale = await failure(harness({ flow: stepUp, identity: { authTime: NOW_S - 600 } }).service.callback(params, callbackUrl, "s", "pg-id", client))
      expect(stale.code).toBe("stale")
      expect(stale.slug).toBe("acme")
      expect((await failure(harness({ flow: stepUp, identity: { authTime: null } }).service.callback(params, callbackUrl, "s", "pg-id", client))).code).toBe("stale")
    })

    it("refuses someone other than the signed-in person, or no one signed in", async () => {
      expect((await failure(harness({ flow: stepUp, pgId: null }).service.callback(params, callbackUrl, "s", undefined, client))).code).toBe("mismatch")
      const other = harness({ flow: stepUp, pgId: { userId: "0190b2f0-0000-7000-8000-000000000009", ssoOrgId: null } })
      expect((await failure(other.service.callback(params, callbackUrl, "s", "pg-id", client))).code).toBe("mismatch")
      expect(other.sessions.open).not.toHaveBeenCalled()
    })
  })
})
