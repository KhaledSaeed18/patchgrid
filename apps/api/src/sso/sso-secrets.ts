import { Injectable } from "@nestjs/common"

import { SecretBox } from "../auth/mfa/secret-box"
import { type AppConfig, InjectConfig } from "../config/app-config"

/**
 * SSO client secrets at rest (ADR-0054): sealed under `SSO_SECRETS_KEY`, a key
 * the database never holds, with the box the second factors and webhooks use.
 * We present the secret to the identity provider, so it cannot be hashed.
 */
@Injectable()
export class SsoSecrets {
  private readonly box: SecretBox

  constructor(@InjectConfig() config: AppConfig) {
    this.box = new SecretBox(config.SSO_SECRETS_KEY)
  }

  seal(secret: string): string {
    return this.box.seal(secret)
  }

  /** `null` when the seal does not open: tampered with, or sealed under another key. */
  open(sealed: string): string | null {
    return this.box.open(sealed)
  }
}
