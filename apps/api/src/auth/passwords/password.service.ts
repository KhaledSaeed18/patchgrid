import { type Algorithm, hash, hashSync, verify } from "@node-rs/argon2"
import { Injectable } from "@nestjs/common"
import { randomBytes } from "node:crypto"

/**
 * Argon2id (ADR-0004), at the library's defaults — 19 MiB, two passes, one
 * lane — which match the OWASP minimum for Argon2id. Raising them is a config
 * change here and nowhere else; existing hashes keep their own parameters.
 */
// `Algorithm` is an ambient const enum the TypeScript config cannot inline;
// Argon2id is its value 2. The spec asserts the produced hash says `$argon2id$`.
const ARGON2ID: Algorithm = 2
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 }

@Injectable()
export class PasswordService {
  /**
   * A hash of a password nobody knows, so a login for an account that does not
   * exist still pays one verification (ADR-0031): the response time of "no such
   * account" and "wrong password" must be the same.
   */
  private readonly dummyHash = hashSync(randomBytes(32).toString("base64url"), OPTIONS)

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS)
  }

  /**
   * Always does one Argon2id verification. `hash` is `null` for an unknown
   * address or an anonymised account; the answer is `false` either way, at the
   * same cost.
   */
  async verify(storedHash: string | null, password: string): Promise<boolean> {
    if (storedHash === null) {
      await verify(this.dummyHash, password)
      return false
    }
    try {
      return await verify(storedHash, password)
    } catch {
      // An unparseable stored hash is corruption, not a wrong password — but the
      // caller gets the same answer; the log line for it belongs to the service.
      return false
    }
  }
}
