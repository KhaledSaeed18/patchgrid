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

export const ALLOWS_SSO_SESSION = Symbol("ALLOWS_SSO_SESSION")

/**
 * A tenant-less route an SSO-scoped identity may use (ADR-0054). Such a
 * session was started by one workspace's identity provider and vouches for
 * nothing account-wide, so every other `@TenantOptional` route refuses it
 * with `403 sso-session-scoped`: deny by default, so the next account route is
 * safe without anyone remembering this list.
 */
export const AllowsSsoSession = (): MethodDecorator => SetMetadata(ALLOWS_SSO_SESSION, true)

export const IS_SIGNED_WEBHOOK = Symbol("IS_SIGNED_WEBHOOK")

/**
 * A machine-to-machine route whose credential is a signature over its body,
 * never a cookie (ADR-0039). CSRF is a browser riding a cookie it holds, so
 * the `X-Requested-With` check does not apply; the route still verifies its
 * signature before anything else. Always paired with `@Public`.
 */
export const SignedWebhook = (): MethodDecorator & ClassDecorator => SetMetadata(IS_SIGNED_WEBHOOK, true)

export const IS_PLATFORM = Symbol("IS_PLATFORM")

/**
 * An operator route under `/platform` (ADR-0040): no tenant is resolved, and
 * the only credential accepted is the platform session, from the `admin.`
 * surface. The service still asserts the actor kind.
 */
export const PlatformRoute = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PLATFORM, true)
