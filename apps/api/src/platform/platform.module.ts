import { Module } from "@nestjs/common"

import { ApiTokenIndexRepository } from "./repositories/api-token-index.repository"
import { MfaRepository } from "./repositories/mfa.repository"
import { PlatformAdminRepository } from "./repositories/platform-admin.repository"
import { PlatformAuditRepository } from "./repositories/platform-audit.repository"
import { EmailVerificationRepository, PasswordResetTokenRepository } from "./repositories/one-time-token.repository"
import { OrganizationRepository } from "./repositories/organization.repository"
import { RefreshTokenRepository } from "./repositories/refresh-token.repository"
import { UserOrgIndexRepository } from "./repositories/user-org-index.repository"
import { UserRepository } from "./repositories/user.repository"

/**
 * Platform-class data access: the tables that carry no tenant policy and are
 * therefore readable before a tenant is known (ADR-0022). Everything tenant-
 * owned lives in its own domain module.
 */
@Module({
  providers: [
    OrganizationRepository,
    ApiTokenIndexRepository,
    UserRepository,
    RefreshTokenRepository,
    UserOrgIndexRepository,
    EmailVerificationRepository,
    PasswordResetTokenRepository,
    PlatformAdminRepository,
    MfaRepository,
    PlatformAuditRepository,
  ],
  exports: [
    OrganizationRepository,
    ApiTokenIndexRepository,
    UserRepository,
    RefreshTokenRepository,
    UserOrgIndexRepository,
    EmailVerificationRepository,
    PasswordResetTokenRepository,
    PlatformAdminRepository,
    MfaRepository,
    PlatformAuditRepository,
  ],
})
export class PlatformModule {}
