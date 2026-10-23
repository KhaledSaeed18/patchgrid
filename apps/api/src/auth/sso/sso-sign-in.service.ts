import { Inject, Injectable, Logger } from "@nestjs/common"
import type { SsoDiscoverResponse, SsoStartQuery } from "@patchgrid/contracts"
import * as oidc from "openid-client"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { ProblemException } from "../../common/problems/problem.exception"
import { PublicUrls } from "../../common/urls"
import { runAsTenant } from "../../platform/run-as-tenant"
import { hostedDomainAdmits, requiresHostedDomain } from "../../sso/hosted-domain"
import { OidcClient, OidcRejectedError, type OidcConnection } from "../../sso/oidc-client"
import { type OrgDomainRecord, OrgDomainRepository } from "../../sso/repositories/org-domain.repository"
import { type SsoConnectionRecord, SsoConnectionRepository } from "../../sso/repositories/sso-connection.repository"
import { SsoSecrets } from "../../sso/sso-secrets"
import { ORGANIZATION_LOOKUP, type OrganizationLookup } from "../../tenancy/organization-lookup"
import type { CookieSpec } from "../cookies"
import { CookieService } from "../cookies"
import { type ClientInfo, SessionService } from "../sessions/session.service"
import { SSO_FLOW_TTL_SECONDS, type SsoFlow, SsoFlowStore } from "./sso-flow-store"
import { SsoFailure, SsoProvisioning } from "./sso-provisioning"

/** How far an IdP's clock may sit behind ours before step-up calls its `auth_time` stale. */
const AUTH_TIME_SKEW_SECONDS = 5

/** Where the browser goes next, and what it carries. */
export type SsoRedirect = { location: string; cookies: CookieSpec[] }

type Routed = { org: OrgDomainRecord; connection: SsoConnectionRecord; domain: string }

/**
 * Signing in through a workspace's identity provider (ADR-0054): the browser
 * goes there with PKCE, a state and a nonce; the API checks everything that
 * comes back — the state against the browser's cookie, the ID token by
 * `openid-client`, a verified address at the workspace's proved domain — and
 * only then decides who it is and starts a session scoped to that workspace.
 */
@Injectable()
export class SsoSignInService {
  private readonly logger = new Logger(SsoSignInService.name)

  constructor(
    private readonly domains: OrgDomainRepository,
    private readonly connections: SsoConnectionRepository,
    private readonly secrets: SsoSecrets,
    private readonly oidc: OidcClient,
    private readonly flows: SsoFlowStore,
    private readonly provisioning: SsoProvisioning,
    private readonly sessions: SessionService,
    private readonly cookies: CookieService,
    private readonly urls: PublicUrls,
    @Inject(ORGANIZATION_LOOKUP) private readonly organizations: OrganizationLookup,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /** Whether this address's domain signs in through a workspace's identity provider. About the domain, never the account. */
  async discover(email: string): Promise<SsoDiscoverResponse> {
    const routed = await this.route({ email }).catch((error: unknown) => {
      if (error instanceof SsoFailure) return null
      throw error
    })
    return { sso: routed === null ? null : { slug: routed.org.slug, name: routed.org.name } }
  }

  /** The authorization request: PKCE, state and nonce kept for ten minutes, the state also in the browser's cookie. */
  async start(query: SsoStartQuery, fetchSite?: string): Promise<SsoRedirect> {
    try {
      // A navigation another site started (login CSRF into its own workspace): browsers say so (M13 review).
      if (fetchSite === "cross-site") throw new SsoFailure("foreign")
      return await this.begin(query)
    } catch (error) {
      if (error instanceof SsoFailure && query.intent === "step-up") {
        error.slug = query.slug
        error.next = query.next
      }
      throw error
    }
  }

  private async begin(query: SsoStartQuery): Promise<SsoRedirect> {
    const routed = await this.route(query.slug === undefined ? { email: query.email ?? "" } : { slug: query.slug })
    const config = await this.configuration(routed.connection)
    const state = oidc.randomState()
    const nonce = oidc.randomNonce()
    const codeVerifier = oidc.randomPKCECodeVerifier()
    const flow: SsoFlow = {
      orgId: routed.org.id,
      connectionId: routed.connection.id,
      codeVerifier,
      nonce,
      intent: query.intent,
      next: query.next ?? null,
      startedAt: Math.floor(this.clock.now().getTime() / 1000),
    }
    await this.flows.put(state, flow)
    const url = this.oidc.authorizationUrl(config, {
      redirectUri: this.urls.ssoCallback(),
      state,
      nonce,
      codeChallenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      ...(query.email === undefined ? {} : { loginHint: query.email }),
      ...(requiresHostedDomain(routed.connection.issuer) ? { hostedDomain: routed.domain } : {}),
      reauthenticate: query.intent === "step-up",
    })
    return { location: url.toString(), cookies: [this.cookies.ssoFlow(state, SSO_FLOW_TTL_SECONDS)] }
  }

  /**
   * The provider's answer. `cookieState` is the browser's `pg_sso`; a callback
   * whose state is not this browser's is somebody else's flow (login CSRF).
   * `identitySecret` is the browser's `pg_id`, which step-up must match.
   */
  async callback(
    params: { code?: string; state?: string; error?: string },
    callbackUrl: URL,
    cookieState: string | undefined,
    identitySecret: string | undefined,
    client: ClientInfo,
  ): Promise<SsoRedirect> {
    if (params.state === undefined || cookieState === undefined || params.state !== cookieState) throw new SsoFailure("expired")
    const flow = await this.flows.take(params.state)
    if (flow === null) throw new SsoFailure("expired")
    try {
      return await this.finish(flow, params, params.state, callbackUrl, identitySecret, client)
    } catch (error) {
      if (error instanceof SsoFailure && flow.intent === "step-up") {
        error.slug = (await this.organizations.byId(flow.orgId))?.slug
        error.next = flow.next ?? undefined
      }
      throw error
    }
  }

  private async finish(
    flow: SsoFlow,
    params: { code?: string; error?: string },
    state: string,
    callbackUrl: URL,
    identitySecret: string | undefined,
    client: ClientInfo,
  ): Promise<SsoRedirect> {
    if (params.error !== undefined || params.code === undefined) throw new SsoFailure("denied")

    const routed = await this.routeFlow(flow)
    const config = await this.configuration(routed.connection)
    let identity
    try {
      identity = await this.oidc.exchange(config, callbackUrl, { codeVerifier: flow.codeVerifier, state, nonce: flow.nonce })
    } catch (error) {
      throw new SsoFailure(error instanceof OidcRejectedError ? "denied" : "unavailable")
    }
    // The workspace's control of its provider must be no more than its control of its own domain.
    if (!identity.emailVerified || identity.email === null || domainOf(identity.email) !== routed.domain) throw new SsoFailure("email")
    // A shared issuer vouches for an address only through the domain's own Workspace (`hd`).
    if (!hostedDomainAdmits(routed.connection.issuer, identity.hostedDomain, routed.domain)) throw new SsoFailure("email")

    const person = { subject: identity.subject, email: identity.email, name: identity.name }
    const current = await this.sessions.identityFor(identitySecret)

    if (flow.intent === "step-up") {
      if (identity.authTime === null || identity.authTime < flow.startedAt - AUTH_TIME_SKEW_SECONDS) throw new SsoFailure("stale")
      // The browser's own person, signed in to this workspace or with Patchgrid credentials — never another's scope.
      if (current === null || (current.ssoOrgId !== null && current.ssoOrgId !== routed.org.id)) throw new SsoFailure("mismatch")
      await this.provisioning.resolve(routed.org, routed.connection, person, {
        mayJoin: false,
        expectedUserId: current.userId,
        refuse: ["OWNER"],
      })
      // The proof came from the provider, so the pair is the provider's: scoped to this workspace.
      const cookies = await this.policy(() =>
        this.sessions.open(current.userId, routed.org.slug, client, { stepUpAt: this.clock.now(), ssoOrgId: routed.org.id }),
      )
      return { location: this.urls.workspace(routed.org.slug, flow.next ?? "/"), cookies }
    }

    const { account } = await this.provisioning.resolve(routed.org, routed.connection, person)
    this.logger.log({ msg: "sso sign-in", orgId: routed.org.id, userId: account.id })
    // Already signed in here as this person with Patchgrid credentials: keep that identity, add this workspace's pair.
    // Replacing it would scope every other workspace away from someone who only wanted this one (M13 review).
    if (current?.userId === account.id && current.ssoOrgId === null) {
      const pair = await this.policy(() => this.sessions.open(account.id, routed.org.slug, client, { ssoOrgId: routed.org.id }))
      return { location: this.urls.workspace(routed.org.slug, flow.next ?? "/"), cookies: pair }
    }
    const started = await this.sessions.startIdentity(account, client, routed.org.slug, routed.org.id)
    // The pair can be withheld (a suspended workspace): the picker says why.
    const location =
      started.response.session === null ? this.urls.app("/workspaces") : this.urls.workspace(routed.org.slug, flow.next ?? "/")
    return { location, cookies: started.cookies }
  }

  /** Opening the workspace can still be refused by its policy or its state; on a redirect that is a code, not a JSON error page. */
  private async policy<T>(open: () => Promise<T>): Promise<T> {
    try {
      return await open()
    } catch (error) {
      if (error instanceof ProblemException) throw new SsoFailure("inactive")
      throw error
    }
  }

  /** Where a failure lands: the login page for a sign-in, back on the workspace for a step-up. */
  failureLocation(failure: SsoFailure): string {
    if (failure.slug === undefined) return this.urls.app(`/login?sso=${failure.code}`)
    // Back where the step-up started; `next` is a validated path on the workspace.
    const back = new URL(failure.next ?? "/", "http://workspace.invalid")
    back.searchParams.set("sso", failure.code)
    return this.urls.workspace(failure.slug, back.pathname + back.search)
  }

  /** By slug or by the address's domain: a live workspace with a proved domain and an enabled connection, or `not-configured`. */
  private async route(by: { slug: string } | { email: string }): Promise<Routed> {
    let org: OrgDomainRecord | null
    if ("slug" in by) {
      const summary = await this.organizations.bySlug(by.slug)
      org = summary === null ? null : await this.domains.find(summary.id)
    } else {
      const domain = domainOf(by.email)
      org = domain === null ? null : await this.domains.findByVerifiedDomain(domain)
    }
    if (org?.status !== "ACTIVE" || org.domain === null || org.domainVerifiedAt === null) throw new SsoFailure("not-configured")
    const orgId = org.id
    const connection = await runAsTenant(orgId, { actor: "sso", reason: "route sso sign-in" }, () => this.connections.find(orgId))
    if (connection?.enabled !== true) throw new SsoFailure("not-configured")
    return { org, connection, domain: org.domain }
  }

  /** The flow's workspace and connection, re-read: a connection replaced or disabled mid-flight ends the flight. */
  private async routeFlow(flow: SsoFlow): Promise<Routed> {
    const org = await this.domains.find(flow.orgId)
    if (org?.status !== "ACTIVE" || org.domain === null || org.domainVerifiedAt === null) throw new SsoFailure("not-configured")
    const connection = await runAsTenant(org.id, { actor: "sso", reason: "finish sso sign-in" }, () => this.connections.find(org.id))
    if (connection?.enabled !== true || connection.id !== flow.connectionId) throw new SsoFailure("not-configured")
    return { org, connection, domain: org.domain }
  }

  private async configuration(connection: SsoConnectionRecord): Promise<oidc.Configuration> {
    const clientSecret = this.secrets.open(connection.clientSecretSealed)
    if (clientSecret === null) {
      this.logger.error({ msg: "sso client secret does not open", orgId: connection.orgId })
      throw new SsoFailure("unavailable")
    }
    const target: OidcConnection = {
      id: connection.id,
      issuer: connection.issuer,
      clientId: connection.clientId,
      clientSecret,
      updatedAt: connection.updatedAt,
    }
    try {
      return await this.oidc.configuration(target)
    } catch {
      throw new SsoFailure("unavailable")
    }
  }
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@")
  return at < 1 ? null : email.slice(at + 1).toLowerCase()
}
