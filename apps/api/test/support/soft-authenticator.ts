import type { PasskeyAssertionCredential, PasskeyCreationOptions, PasskeyRegistrationCredential, PasskeyRequestOptions } from "@patchgrid/contracts"
import { isoCBOR } from "@simplewebauthn/server/helpers"
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto"

const UP = 0x01
const UV = 0x04
const BE = 0x08
const BS = 0x10
const AT = 0x40

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest()

type Held = { credentialId: Buffer; privateKey: KeyObject; userHandle: string; counter: number }

/**
 * A software WebAuthn authenticator for tests (ADR-0053): an ES256 key per
 * credential, attestation `none`, discoverable credentials, and a counter it
 * can be told to keep at zero (a synced passkey) or to count. It answers the
 * options the API returns exactly as a browser would, signing whatever origin
 * it is told it is on — which is how the tests stand on a host the API must
 * refuse.
 */
export class SoftAuthenticator {
  private readonly held: Held[] = []

  constructor(private readonly options: { synced?: boolean; userVerified?: boolean } = {}) {}

  /** `navigator.credentials.create()`, on `origin`. */
  create(options: PasskeyCreationOptions, origin: string): PasskeyRegistrationCredential {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
    const jwk = publicKey.export({ format: "jwk" })
    if (jwk.x === undefined || jwk.y === undefined) throw new Error("no EC point")
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    )
    const credentialId = randomBytes(32)
    const counter = this.options.synced === true ? 0 : 1
    const length = Buffer.alloc(2)
    length.writeUInt16BE(credentialId.length)
    const authData = Buffer.concat([this.header(options.rp.id ?? "", AT, counter), Buffer.alloc(16), length, credentialId, Buffer.from(cose)])
    const attestation = new Map<string, string | Uint8Array | Map<string, never>>()
    attestation.set("fmt", "none").set("attStmt", new Map<string, never>()).set("authData", authData)
    const attestationObject = isoCBOR.encode(attestation)
    this.held.push({ credentialId, privateKey, userHandle: options.user.id, counter })
    return {
      id: b64(credentialId),
      rawId: b64(credentialId),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: this.clientData("webauthn.create", options.challenge, origin),
        attestationObject: b64(attestationObject),
        transports: ["internal"],
      },
    }
  }

  /**
   * `navigator.credentials.get()`, on `origin`: the newest credential this
   * authenticator holds that the options allow. `counter` overrides what is
   * signed, for the cloned-key case.
   */
  get(options: PasskeyRequestOptions, origin: string, override: { counter?: number; rpId?: string } = {}): PasskeyAssertionCredential {
    const allowed = options.allowCredentials?.map((c) => c.id)
    const credential = [...this.held].reverse().find((h) => allowed === undefined || allowed.includes(b64(h.credentialId)))
    if (credential === undefined) throw new Error("no credential for these options")
    if (this.options.synced !== true) credential.counter += 1
    const authData = this.header(override.rpId ?? options.rpId ?? "", 0, override.counter ?? credential.counter)
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin)
    const signature = sign("sha256", Buffer.concat([authData, sha256(Buffer.from(clientDataJSON, "base64url"))]), credential.privateKey)
    return {
      id: b64(credential.credentialId),
      rawId: b64(credential.credentialId),
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON, authenticatorData: b64(authData), signature: b64(signature), userHandle: credential.userHandle },
    }
  }

  private header(rpId: string, extra: number, counter: number): Buffer {
    const flags = UP | (this.options.userVerified === false ? 0 : UV) | (this.options.synced === true ? BE | BS : 0) | extra
    const count = Buffer.alloc(4)
    count.writeUInt32BE(counter)
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count])
  }

  private clientData(type: string, challenge: string, origin: string): string {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString("base64url")
  }
}
