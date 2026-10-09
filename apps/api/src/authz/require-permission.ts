import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { Permission } from "@patchgrid/contracts"

import { ActorService } from "../auth/actor"
import { NotPermittedProblem } from "../common/problems/problem.exception"
import { PermissionService } from "./permission.service"

export const REQUIRED_PERMISSION = Symbol("REQUIRED_PERMISSION")

/**
 * The permission a tenant-bound route needs at ROLE level — the first filter
 * (RBAC.md §1). It stops a requester before the service loads anything; the
 * decision that matters is still the service's `assert` on the resolved
 * subject, because "own, while NEW" cannot be answered from a route.
 *
 * Every route carries this, `@Public` or `@TenantOptional` — the route-coverage
 * test fails the build otherwise (RBAC.md §13.3).
 */
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION, permission)

/**
 * Pipeline step 8, after the auth guard has set the actor. A route without the
 * marker passes here; the coverage test is what makes "without the marker"
 * mean "deliberately public or tenant-optional".
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly actors: ActorService,
    private readonly permissions: PermissionService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ])
    if (permission === undefined) return true
    if (!this.permissions.permissionsFor(this.actors.current()).includes(permission)) {
      throw new NotPermittedProblem()
    }
    return true
  }
}
