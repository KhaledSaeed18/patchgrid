import { Module } from "@nestjs/common"

import { PasswordService } from "../auth/passwords/password.service"
import { ApiTokenVerifier } from "./api-token-verifier"
import { ApiTokenRepository } from "./repositories/api-token.repository"

/**
 * What the bearer path and the token routes share (ADR-0042): the rows and
 * the verifier. Free of the auth module, so its guard can use both.
 */
@Module({
  providers: [ApiTokenRepository, ApiTokenVerifier, PasswordService],
  exports: [ApiTokenRepository, ApiTokenVerifier],
})
export class ApiTokenCoreModule {}
