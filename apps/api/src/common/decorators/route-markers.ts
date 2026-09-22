import { SetMetadata } from "@nestjs/common"

/**
 * Route markers.
 *
 * Authorization is **deny by default** (`RBAC.md` §1), and a CI route-coverage
 * test reflects over every controller route: one that has neither a marker here
 * nor a permission assertion in its service fails the build (ADR-0019). These
 * decorators are how a route declares that it is deliberately unguarded — an
 * explicit, greppable, reviewable statement rather than an omission.
 */

export const IS_PUBLIC = Symbol("IS_PUBLIC")
export const IS_TENANT_OPTIONAL = Symbol("IS_TENANT_OPTIONAL")

/**
 * No authentication at all: signup, login, slug availability, health.
 *
 * Every use is a decision to expose something to the internet, so each one
 * carries a reason in code review.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true)

/**
 * Authenticated, but not bound to a tenant: the org picker, accepting an
 * invitation, creating a workspace.
 *
 * These may not touch tenant-owned repositories except through `runAsTenant` /
 * `runAsPlatform` (ADR-0022).
 */
export const TenantOptional = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_TENANT_OPTIONAL, true)
