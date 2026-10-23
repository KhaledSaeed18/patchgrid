/**
 * A small OpenID provider in the spec's own process (ADR-0054): discovery,
 * keys, and a token endpoint that checks the client's secret and the PKCE
 * verifier before it signs an ID token. `authorize` plays the person at the
 * provider's login page and returns where the provider would send the browser.
 *
 * Real signatures, real discovery, the real guarded fetch: what the API's
 * callback checks is checked against this, without Keycloak in CI.
 */
import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"

export type IdpPerson = { sub: string; email: string; emailVerified?: boolean; name?: string; authTime?: number }

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]

type Grant = { person: IdpPerson; nonce: string; challenge: string; redirectUri: string; clientId: string }

export class FakeIdp {
  readonly clientId = "patchgrid-spec"
  readonly clientSecret = randomBytes(24).toString("base64url")
  /** Every authorization request the browser was sent with, for the spec to inspect. */
  readonly requests: URL[] = []
  /** A different issuer name in discovery: what a provider impersonating another would say. */
  claimedIssuer: string | null = null
  /** Tamper with the next ID tokens: sign them with a key not in the published set, or name another audience. */
  forge: { rogueKey?: boolean; audience?: string } = {}
  private server: Server | null = null
  private key: SigningKey | null = null
  private rogue: SigningKey | null = null
  private jwk: JWK | null = null
  private readonly grants = new Map<string, Grant>()
  private port = 0

  get issuer(): string {
    return `http://127.0.0.1:${String(this.port)}/realms/spec`
  }

  async start(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true })
    this.key = privateKey
    this.rogue = (await generateKeyPair("ES256")).privateKey
    this.jwk = { ...(await exportJWK(publicKey)), kid: "spec-1", alg: "ES256", use: "sig" }
    this.server = createServer((request, response) => {
      void this.handle(request).then(({ status, body }) => {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
        response.end(JSON.stringify(body))
      })
    })
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve))
    this.port = (this.server.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server === null ? resolve() : this.server.close(() => resolve())))
  }

  /** The person signs in at the provider; returns the callback URL the browser is redirected to. */
  authorize(authorizationUrl: string, person: IdpPerson): URL {
    const url = new URL(authorizationUrl)
    this.requests.push(url)
    if (url.origin + url.pathname !== `${this.issuer}/authorize`) throw new Error(`not this provider: ${authorizationUrl}`)
    const get = (name: string) => {
      const value = url.searchParams.get(name)
      if (value === null) throw new Error(`authorization request without ${name}`)
      return value
    }
    if (get("response_type") !== "code" || get("code_challenge_method") !== "S256") throw new Error("not a PKCE code request")
    const code = randomBytes(16).toString("base64url")
    this.grants.set(code, {
      person,
      nonce: get("nonce"),
      challenge: get("code_challenge"),
      redirectUri: get("redirect_uri"),
      clientId: get("client_id"),
    })
    const callback = new URL(get("redirect_uri"))
    callback.searchParams.set("code", code)
    callback.searchParams.set("state", get("state"))
    return callback
  }

  private async handle(request: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const path = new URL(request.url ?? "/", this.issuer).pathname
    if (request.method === "GET" && path === "/realms/spec/.well-known/openid-configuration") {
      return {
        status: 200,
        body: {
          issuer: this.claimedIssuer ?? this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        },
      }
    }
    if (request.method === "GET" && path === "/realms/spec/jwks") return { status: 200, body: { keys: [this.jwk] } }
    if (request.method === "POST" && path === "/realms/spec/token") return this.token(request)
    return { status: 404, body: { error: "not_found" } }
  }

  private async token(request: IncomingMessage): Promise<{ status: number; body: unknown }> {
    // RFC 6749 §2.3.1: both halves form-encoded before base64, so a `-` arrives as `%2D`.
    const [scheme, encoded] = (request.headers.authorization ?? "").split(" ")
    const [id = "", secret = ""] = Buffer.from(encoded ?? "", "base64")
      .toString("utf8")
      .split(":")
    const decode = (part: string) => decodeURIComponent(part.replace(/\+/g, " "))
    if (scheme !== "Basic" || decode(id) !== this.clientId || decode(secret) !== this.clientSecret)
      return { status: 401, body: { error: "invalid_client" } }
    const form = new URLSearchParams(await bodyOf(request))
    const grant = this.grants.get(form.get("code") ?? "")
    this.grants.delete(form.get("code") ?? "")
    if (grant === undefined || form.get("grant_type") !== "authorization_code" || form.get("redirect_uri") !== grant.redirectUri) {
      return { status: 400, body: { error: "invalid_grant" } }
    }
    const verifier = form.get("code_verifier") ?? ""
    if (createHash("sha256").update(verifier).digest("base64url") !== grant.challenge)
      return { status: 400, body: { error: "invalid_grant", error_description: "PKCE" } }
    const now = Math.floor(Date.now() / 1000)
    const idToken = await new SignJWT({
      email: grant.person.email,
      email_verified: grant.person.emailVerified ?? true,
      ...(grant.person.name === undefined ? {} : { name: grant.person.name }),
      nonce: grant.nonce,
      auth_time: grant.person.authTime ?? now,
    })
      .setProtectedHeader({ alg: "ES256", kid: "spec-1" })
      .setIssuer(this.issuer)
      .setAudience(this.forge.audience ?? grant.clientId)
      .setSubject(grant.person.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign((this.forge.rogueKey === true ? this.rogue : this.key) as SigningKey)
    return {
      status: 200,
      body: { access_token: randomBytes(16).toString("base64url"), token_type: "Bearer", expires_in: 300, id_token: idToken },
    }
  }
}

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}
