import { Module } from "@nestjs/common"
import { APP_GUARD } from "@nestjs/core"

import { BullModule } from "@nestjs/bullmq"

import { MailModule } from "../mail/mail.module"
import { QuotaModule } from "../quota/quota.module"
import { AccountController } from "./account/account.controller"
import { AccountErasureService } from "./account/account-erasure.service"
import { AccountErasureRepository } from "./account/repositories/account-erasure.repository"
import { CREDENTIAL_RETENTION_QUEUE, CredentialRetentionProcessor, CredentialRetentionService } from "./credential-retention"
import { MembershipRepositoryModule } from "../memberships/membership-repository.module"
import { PlatformModule } from "../platform/platform.module"
import { ActorService } from "./actor"
import { AuthController } from "./auth.controller"
import { AuthGuard } from "./auth.guard"
import { CookieService } from "./cookies"
import { IdentityController } from "./identity/identity.controller"
import { IdentityService } from "./identity/identity.service"
import { ApiTokenCoreModule } from "../api-tokens/api-token-core.module"
import { AccountSecurityNotifier } from "./mfa/account-security-notifier"
import { FactorLockout } from "./mfa/factor-lockout"
import { MemberMfaService } from "./mfa/member-mfa.service"
import { MfaChallengeService } from "./mfa/mfa-challenge.service"
import { MfaController } from "./mfa/mfa.controller"
import { StepUpService } from "./mfa/step-up.service"
import { PasskeyCeremonies } from "./passkeys/passkey-ceremonies"
import { PasskeyChallengeStore } from "./passkeys/passkey-challenges"
import { PasskeyController } from "./passkeys/passkey.controller"
import { PasskeyService } from "./passkeys/passkey.service"
import { PasswordService } from "./passwords/password.service"
import { PlatformAuthController } from "./platform/platform-auth.controller"
import { PlatformAuthService } from "./platform/platform-auth.service"
import { PlatformTokenService } from "./platform/platform-token.service"
import { SupportReadLog } from "./support/support-read-log"
import { SupportTokenService } from "./support/support-token.service"
import { SupportCoreModule } from "../support/support-core.module"
import { RequestedWithGuard } from "./requested-with.guard"
import { RevocationEpochService } from "./revocation/revocation-epoch.service"
import { SessionService } from "./sessions/session.service"
import { StandingService } from "./sessions/standing.service"
import { AccessTokenService } from "./tokens/access-token.service"
import { OrgThrottlerGuard } from "../throttling/throttler.guards"

/**
 * Pipeline step 7 and the session routes. The two guards register here, after
 * the tenancy module's resolution guard, so the order is: resolve the tenant,
 * refuse cookie-borne mutations without the CSRF header, verify the credential.
 */
@Module({
  imports: [
    PlatformModule,
    MembershipRepositoryModule,
    MailModule,
    QuotaModule,
    SupportCoreModule,
    ApiTokenCoreModule,
    BullModule.registerQueue({ name: CREDENTIAL_RETENTION_QUEUE }),
  ],
  controllers: [AuthController, IdentityController, PlatformAuthController, MfaController, PasskeyController, AccountController],
  providers: [
    CookieService,
    PasswordService,
    AccessTokenService,
    RevocationEpochService,
    SessionService,
    StandingService,
    IdentityService,
    ActorService,
    PlatformTokenService,
    PlatformAuthService,
    SupportTokenService,
    SupportReadLog,
    FactorLockout,
    MfaChallengeService,
    MemberMfaService,
    StepUpService,
    AccountSecurityNotifier,
    PasskeyChallengeStore,
    PasskeyCeremonies,
    PasskeyService,
    AccountErasureRepository,
    AccountErasureService,
    CredentialRetentionService,
    CredentialRetentionProcessor,
    { provide: APP_GUARD, useClass: RequestedWithGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    // Per-org limits count verified requests only: after the credential, never on a bare claim (THREAT-MODEL §7).
    { provide: APP_GUARD, useClass: OrgThrottlerGuard },
  ],
  exports: [ActorService, RevocationEpochService, SessionService, StandingService, CookieService, PasswordService, SupportTokenService, SupportReadLog, StepUpService],
})
export class AuthModule {}
