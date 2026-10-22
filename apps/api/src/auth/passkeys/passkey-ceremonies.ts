import { Injectable, Logger } from "@nestjs/common"
import {
  PASSKEY_CHALLENGE_TTL_SECONDS,
  type PasskeyAssertionCredential,
  type PasskeyCreationCeremony,
  passkeyCreationOptionsSchema,
  type PasskeyRegistrationCredential,
  type PasskeyRequestCeremony,
  passkeyRequestOptionsSchema,
} from "@patchgrid/contracts"
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server"
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { classifyOrigin, originPolicyFrom } from "../../common/http/origin-policy"
import { InjectConfig, type AppConfig } from "../../config/app-config"
import type { NewPasskey, PasskeyRecord } from "../../platform/repositories/passkey.repository"
import { PasskeyRepository } from "../../platform/repositories/passkey.repository"
import { AccountSecurityNotifier } from "../mfa/account-security-notifier"
import { PasskeyChallengeStore } from "./passkey-challenges"

const RP_NAME = "Patchgrid"

/** A verified assertion: whose passkey it was. */
export type Asserted = { userId: string; passkeyId: string }

/**
 * The WebAuthn ceremonies (ADR-0053), and the only code that speaks to
 * `@simplewebauthn/server`. Three rules hold for every ceremony:
 *
 * - **The relying party is the root domain**, so one passkey works on every
 *   workspace host; **the origin decides where it counts.** The origin
 *   signed into the client data must classify as a workspace host or `app.`
 *   by the same policy CORS and tenant resolution use. `admin.`, `www.`, the
 *   apex and anything foreign are refused before the signature is looked at.
 * - **User verification is required**: the device's PIN or biometric is the
 *   second factor, which is what lets a passkey stand alone.
 * - **A challenge is spent once, for the purpose it was issued for**, and
 *   for the person it was issued to.
 *
 * Every refusal is `null`; callers turn that into their own uniform answer.
 */
@Injectable()
export class PasskeyCeremonies {
  private readonly logger = new Logger(PasskeyCeremonies.name)

  constructor(
    private readonly passkeys: PasskeyRepository,
    private readonly challenges: PasskeyChallengeStore,
    private readonly notifier: AccountSecurityNotifier,
    @InjectConfig() private readonly config: AppConfig,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /** A discoverable credential, user-verified, no attestation; the person's existing passkeys excluded. */
  async creationOptions(user: { id: string; email: string; name: string }, existing: readonly PasskeyRecord[]): Promise<PasskeyCreationCeremony> {
    const issued = await this.challenges.issue("register", user.id)
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: this.config.ROOT_DOMAIN,
      userID: userHandleBytes(user.id),
      userName: user.email,
      userDisplayName: user.name === "" ? user.email : user.name,
      challenge: Buffer.from(issued.challenge, "base64url"),
      timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
      // Patchgrid keeps no allow-list of authenticator makes, so proof of make would be checked against nothing.
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: base64url(p.credentialId), transports: p.transports })),
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    })
    return { challengeId: issued.id, options: passkeyCreationOptionsSchema.parse(options) }
  }

  /**
   * Options for an assertion. A passwordless login names no one, so it lists
   * no credentials and the authenticator offers whatever it holds for this
   * relying party; a proof lists the person's own.
   */
  async requestOptions(purpose: "login" | "proof", userId: string | null, allow: readonly PasskeyRecord[]): Promise<PasskeyRequestCeremony> {
    const issued = await this.challenges.issue(purpose, userId)
    const options = await generateAuthenticationOptions({
      rpID: this.config.ROOT_DOMAIN,
      challenge: Buffer.from(issued.challenge, "base64url"),
      timeout: PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
      userVerification: "required",
      ...(purpose === "login" ? {} : { allowCredentials: allow.map((p) => ({ id: base64url(p.credentialId), transports: p.transports })) }),
    })
    return { challengeId: issued.id, options: passkeyRequestOptionsSchema.parse(options) }
  }

  /** The new credential, verified against the challenge issued to this person; `null` for anything else. */
  async verifyRegistration(userId: string, challengeId: string, credential: PasskeyRegistrationCredential, label: string): Promise<NewPasskey | null> {
    const spent = await this.challenges.spend(challengeId, "register")
    if (spent === null || spent.userId !== userId) return null
    const origin = this.acceptedOrigin(credential.response.clientDataJSON)
    if (origin === null) return null
    try {
      const result = await verifyRegistrationResponse({
        response: registrationJSON(credential),
        expectedChallenge: spent.challenge,
        expectedOrigin: origin,
        expectedRPID: this.config.ROOT_DOMAIN,
        requireUserVerification: true,
      })
      if (!result.verified) return null
      const info = result.registrationInfo
      return {
        credentialId: Buffer.from(info.credential.id, "base64url"),
        publicKey: info.credential.publicKey,
        signCount: BigInt(info.credential.counter),
        transports: credential.response.transports ?? info.credential.transports ?? [],
        aaguid: info.aaguid,
        backedUp: info.credentialBackedUp,
        label,
      }
    } catch (error) {
      this.logger.warn({ msg: "passkey registration refused", userId, error: String(error) })
      return null
    }
  }

  /**
   * A signed assertion, verified: the challenge spent for this purpose, the
   * origin a workspace host or `app.`, the credential known, its owner the
   * person expected (or, for a passwordless login, named by `userHandle`),
   * the user verified, and the counter not gone backwards.
   *
   * `expectedUserId` is `null` only for a passwordless login.
   */
  async verifyAssertion(purpose: "login" | "proof", challengeId: string, credential: PasskeyAssertionCredential, expectedUserId: string | null): Promise<Asserted | null> {
    const spent = await this.challenges.spend(challengeId, purpose)
    if (spent === null || spent.userId !== expectedUserId) return null
    const origin = this.acceptedOrigin(credential.response.clientDataJSON)
    if (origin === null) return null
    const stored = await this.passkeys.findByCredentialId(Buffer.from(credential.id, "base64url"))
    if (stored === null) return null
    if (expectedUserId !== null && stored.userId !== expectedUserId) return null
    // A discoverable sign-in names its owner; it must be the credential's.
    const handle = credential.response.userHandle
    if ((handle === undefined && purpose === "login") || (handle !== undefined && handle !== base64url(userHandleBytes(stored.userId)))) return null

    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
    try {
      verified = await verifyAuthenticationResponse({
        response: assertionJSON(credential),
        expectedChallenge: spent.challenge,
        expectedOrigin: origin,
        expectedRPID: this.config.ROOT_DOMAIN,
        // The counter is checked below, after the signature: the library checks it first,
        // and a forged assertion must not be able to set off the cloned-key mail.
        credential: { id: credential.id, publicKey: Uint8Array.from(stored.publicKey), counter: 0, transports: stored.transports },
        requireUserVerification: true,
      })
    } catch (error) {
      this.logger.warn({ msg: "passkey assertion refused", userId: stored.userId, error: String(error) })
      return null
    }
    if (!verified.verified) return null

    const presented = BigInt(verified.authenticationInfo.newCounter)
    if ((presented > 0n || stored.signCount > 0n) && presented <= stored.signCount) {
      // A cloned authenticator is the only innocent-looking explanation (ADR-0053).
      this.logger.warn({ msg: "passkey counter went backwards", userId: stored.userId, passkeyId: stored.id })
      await this.notifier.tell(stored.userId, "passkey-cloned", 0)
      return null
    }
    const recorded = await this.passkeys.recordUse(stored.id, stored.signCount, presented, verified.authenticationInfo.credentialBackedUp, this.clock.now())
    if (!recorded) return null
    return { userId: stored.userId, passkeyId: stored.id }
  }

  /**
   * The origin signed into the client data, when it is one a passkey counts
   * on: a workspace host or `app.` (ADR-0053). Scheme and port come from the
   * same policy, so plain http with a development port passes only outside
   * production.
   */
  private acceptedOrigin(clientDataJSON: string): string | null {
    let origin: string
    try {
      origin = decodeClientDataJSON(clientDataJSON).origin
    } catch {
      return null
    }
    if (typeof origin !== "string") return null
    const where = classifyOrigin(origin, originPolicyFrom(this.config))
    return where.kind === "tenant" || (where.kind === "infrastructure" && where.label === "app") ? origin : null
  }
}

/** The WebAuthn user handle: the person's id as its sixteen bytes, nothing personal. */
export function userHandleBytes(userId: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(userId.replace(/-/g, ""), "hex"))
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

/** The wire shape as the library types it: an absent optional is absent, not `undefined`. */
function registrationJSON(c: PasskeyRegistrationCredential): RegistrationResponseJSON {
  const r = c.response
  return {
    id: c.id,
    rawId: c.rawId,
    type: c.type,
    clientExtensionResults: {},
    ...(c.authenticatorAttachment === undefined ? {} : { authenticatorAttachment: c.authenticatorAttachment }),
    response: {
      clientDataJSON: r.clientDataJSON,
      attestationObject: r.attestationObject,
      ...(r.authenticatorData === undefined ? {} : { authenticatorData: r.authenticatorData }),
      ...(r.transports === undefined ? {} : { transports: r.transports }),
      ...(r.publicKeyAlgorithm === undefined ? {} : { publicKeyAlgorithm: r.publicKeyAlgorithm }),
      ...(r.publicKey === undefined ? {} : { publicKey: r.publicKey }),
    },
  }
}

function assertionJSON(c: PasskeyAssertionCredential): AuthenticationResponseJSON {
  const r = c.response
  return {
    id: c.id,
    rawId: c.rawId,
    type: c.type,
    clientExtensionResults: {},
    ...(c.authenticatorAttachment === undefined ? {} : { authenticatorAttachment: c.authenticatorAttachment }),
    response: {
      clientDataJSON: r.clientDataJSON,
      authenticatorData: r.authenticatorData,
      signature: r.signature,
      ...(r.userHandle === undefined ? {} : { userHandle: r.userHandle }),
    },
  }
}
