import { Module } from "@nestjs/common"
import { APP_GUARD } from "@nestjs/core"

import { MailModule } from "../mail/mail.module"
import { MembershipsModule } from "../memberships/memberships.module"
import { PlatformModule } from "../platform/platform.module"
import { ActorService } from "./actor"
import { AuthController } from "./auth.controller"
import { AuthGuard } from "./auth.guard"
import { CookieService } from "./cookies"
import { IdentityController } from "./identity/identity.controller"
import { IdentityService } from "./identity/identity.service"
import { PasswordService } from "./passwords/password.service"
import { RequestedWithGuard } from "./requested-with.guard"
import { RevocationEpochService } from "./revocation/revocation-epoch.service"
import { SessionService } from "./sessions/session.service"
import { AccessTokenService } from "./tokens/access-token.service"

/**
 * Pipeline step 7 and the session routes. The two guards register here, after
 * the tenancy module's resolution guard, so the order is: resolve the tenant,
 * refuse cookie-borne mutations without the CSRF header, verify the credential.
 */
@Module({
  imports: [PlatformModule, MembershipsModule, MailModule],
  controllers: [AuthController, IdentityController],
  providers: [
    CookieService,
    PasswordService,
    AccessTokenService,
    RevocationEpochService,
    SessionService,
    IdentityService,
    ActorService,
    { provide: APP_GUARD, useClass: RequestedWithGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [ActorService, RevocationEpochService],
})
export class AuthModule {}
