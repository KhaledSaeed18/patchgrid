import { Injectable } from "@nestjs/common"

import { SecretBox } from "../auth/mfa/secret-box"
import { type AppConfig, InjectConfig } from "../config/app-config"

/**
 * Signing secrets at rest (ADR-0050): sealed under `WEBHOOK_SECRETS_KEY`, a key
 * the database never holds, with the same box the second factors use.
 */
@Injectable()
export class WebhookSecrets {
  private readonly box: SecretBox

  constructor(@InjectConfig() config: AppConfig) {
    this.box = new SecretBox(config.WEBHOOK_SECRETS_KEY)
  }

  seal(secret: string): string {
    return this.box.seal(secret)
  }

  /** Every secret that still signs: the current one, and a rotated-out one until it lapses. */
  inForce(endpoint: { secretSealed: string; previousSecretSealed: string | null; previousSecretExpiresAt: Date | null }, now: Date): string[] {
    const current = this.box.open(endpoint.secretSealed)
    if (current === null) throw new Error("a webhook secret does not open under WEBHOOK_SECRETS_KEY")
    const previous =
      endpoint.previousSecretSealed !== null && endpoint.previousSecretExpiresAt !== null && endpoint.previousSecretExpiresAt > now
        ? this.box.open(endpoint.previousSecretSealed)
        : null
    return previous === null ? [current] : [current, previous]
  }
}
