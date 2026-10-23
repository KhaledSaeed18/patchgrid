import { Injectable, Logger } from "@nestjs/common"
import { emailSchema } from "@patchgrid/contracts"
import * as oidc from "openid-client"

import { type Clock, InjectClock } from "../common/clock/clock"
import { BlockedTargetError, checkTarget, requestSafely } from "../common/http/safe-request"
import { type AppConfig, InjectConfig } from "../config/app-config"

/** What the API needs to talk to one workspace's identity provider. */
export type OidcConnection = { id: string; issuer: string; clientId: string; clientSecret: string; updatedAt: Date }

/** The claims a sign-in rests on, already checked: signature, issuer, audience, expiry, nonce. */
export type VerifiedIdentity = {
  subject: string
  email: string | null
  emailVerified: boolean
  name: string | null
  /** When the person last authenticated at the provider, unix seconds; what step-up checks. */
  authTime: number | null
}

/** The provider could not be reached, or answered something that is not OpenID Connect. Not the person's fault. */
export class OidcUnavailableError extends Error {}
/** The provider answered, and the answer failed a check. */
export class OidcRejectedError extends Error {}

const TIMEOUT_MS = 5_000
const MAX_BODY_BYTES = 1_000_000
const DISCOVERY_TTL_MS = 10 * 60_000
/** Connections whose discovery is kept at once; past it, the oldest go. */
const DISCOVERY_CACHE_MAX = 256

/**
 * OpenID Connect, authorization code with PKCE (ADR-0054), through
 * `openid-client` — which validates the ID token's signature against the
 * provider's keys, its issuer, audience, expiry and nonce — with every request
 * it makes sent through the guarded fetch webhooks use. The issuer is
 * tenant-chosen, so discovery, the keys and the token endpoint are SSRF-shaped
 * exactly as a webhook URL is: vetted addresses, no redirects, five seconds.
 *
 * Discovery is cached per connection version for ten minutes; a saved change
 * has a new `updatedAt` and is discovered afresh, and drops the old version.
 *
 * The ID token's signature is checked against the provider's published keys
 * (`enableNonRepudiationChecks`): `openid-client` does not by default, relying
 * on TLS to the token endpoint, and a local provider has no TLS (M13 review).
 */
@Injectable()
export class OidcClient {
  private readonly logger = new Logger(OidcClient.name)
  private readonly discovered = new Map<string, { config: oidc.Configuration; at: number }>()
  private readonly allowPrivate: boolean

  constructor(
    @InjectConfig() config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {
    this.allowPrivate = config.SSO_ALLOW_PRIVATE_ISSUERS
  }

  /** Runs discovery now, uncached: what saving a connection does, so a typo is a `400` today, not a broken sign-in later. */
  async check(connection: Omit<OidcConnection, "id" | "updatedAt">): Promise<void> {
    await this.discover(connection)
  }

  async configuration(connection: OidcConnection): Promise<oidc.Configuration> {
    const key = `${connection.id}:${String(connection.updatedAt.getTime())}`
    const now = this.clock.now().getTime()
    const cached = this.discovered.get(key)
    if (cached !== undefined && now - cached.at < DISCOVERY_TTL_MS) return cached.config
    const config = await this.discover(connection)
    for (const stale of this.discovered.keys()) if (stale.startsWith(`${connection.id}:`)) this.discovered.delete(stale)
    // Insertion order is age order: the first key is the oldest.
    while (this.discovered.size >= DISCOVERY_CACHE_MAX) {
      const oldest = this.discovered.keys().next().value
      if (oldest === undefined) break
      this.discovered.delete(oldest)
    }
    this.discovered.set(key, { config, at: now })
    return config
  }

  authorizationUrl(
    config: oidc.Configuration,
    params: { redirectUri: string; state: string; nonce: string; codeChallenge: string; loginHint?: string; reauthenticate: boolean },
  ): URL {
    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: params.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      ...(params.loginHint === undefined ? {} : { login_hint: params.loginHint }),
      // Step-up: a fresh authentication at the provider, which `auth_time` must then show (ADR-0054).
      ...(params.reauthenticate ? { prompt: "login", max_age: "0" } : {}),
    })
  }

  /** The code for tokens, and the ID token checked. Rejects with one of the two errors above, never anything else. */
  async exchange(
    config: oidc.Configuration,
    callbackUrl: URL,
    checks: { codeVerifier: string; state: string; nonce: string },
  ): Promise<VerifiedIdentity> {
    let claims: oidc.IDToken | undefined
    try {
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      })
      claims = tokens.claims()
    } catch (error) {
      throw this.classify(error, "token exchange")
    }
    if (claims === undefined) throw new OidcRejectedError("no ID token")
    // The address becomes a global account's: it must be one the contracts would accept at signup.
    const email = emailSchema.safeParse(claims.email)
    return {
      subject: claims.sub,
      email: email.success ? email.data : null,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === "string" ? claims.name : null,
      authTime: typeof claims.auth_time === "number" ? claims.auth_time : null,
    }
  }

  private async discover(connection: Omit<OidcConnection, "id" | "updatedAt">): Promise<oidc.Configuration> {
    let issuer: URL
    try {
      issuer = checkTarget(connection.issuer, this.allowPrivate)
    } catch (error) {
      throw new OidcRejectedError(error instanceof BlockedTargetError ? error.message.replace("webhook target refused", "issuer refused") : "not a URL")
    }
    try {
      return await oidc.discovery(issuer, connection.clientId, undefined, oidc.ClientSecretBasic(connection.clientSecret), {
        [oidc.customFetch]: this.fetch,
        execute: [
          oidc.enableNonRepudiationChecks,
          // Plain http only for the local Keycloak, which the config refuses in production.
          ...(issuer.protocol === "http:" && this.allowPrivate ? [oidc.allowInsecureRequests] : []),
        ],
      })
    } catch (error) {
      throw this.classify(error, "discovery")
    }
  }

  /** `openid-client`'s fetch, through the guarded request: every address vetted at connect, no redirects. */
  private readonly fetch: oidc.CustomFetch = async (url, options) => {
    const body = options.body
    const payload =
      body === undefined || body === null
        ? null
        : typeof body === "string"
          ? body
          : body instanceof URLSearchParams
            ? body.toString()
            : body instanceof ArrayBuffer
              ? Buffer.from(body)
              : ArrayBuffer.isView(body)
                ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
                : null
    // Typed as a record, handed over as `Headers` at run time; spreading a `Headers` copies nothing.
    const given: unknown = options.headers
    const headers = given instanceof Headers ? Object.fromEntries(given.entries()) : options.headers
    const answer = await requestSafely(options.method, url, payload, {
      headers,
      timeoutMs: TIMEOUT_MS,
      maxBodyBytes: MAX_BODY_BYTES,
      allowPrivate: this.allowPrivate,
    })
    const nullBody = answer.status === 204 || answer.status === 304
    return new Response(nullBody ? null : answer.body, { status: answer.status, headers: answer.headers })
  }

  /** Network and protocol trouble is the provider's; a failed check is the answer's. The detail goes to the log only. */
  private classify(error: unknown, step: string): Error {
    if (error instanceof OidcRejectedError || error instanceof OidcUnavailableError) return error
    const message = error instanceof Error ? error.message : String(error)
    this.logger.warn({ msg: "identity provider request failed", step, error: message })
    if (error instanceof BlockedTargetError) return new OidcRejectedError("issuer refused")
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : ""
    // `openid-client` names its own validation failures; anything else is the wire.
    if (code.startsWith("OAUTH_") && !["OAUTH_RESPONSE_IS_NOT_JSON", "OAUTH_RESPONSE_IS_NOT_CONFORM"].includes(code)) return new OidcRejectedError(code)
    return new OidcUnavailableError(step)
  }
}
