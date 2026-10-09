import { Global, Module } from "@nestjs/common"
import { APP_GUARD } from "@nestjs/core"

import { AuthModule } from "../auth/auth.module"
import { PermissionService } from "./permission.service"
import { PermissionGuard } from "./require-permission"

/**
 * Authorization within a tenant (ADR-0019, RBAC.md). Global, because every
 * domain service asserts through `PermissionService`. Imported after
 * `AuthModule`, so its guard runs after the actor exists.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [PermissionService, { provide: APP_GUARD, useClass: PermissionGuard }],
  exports: [PermissionService],
})
export class AuthzModule {}
