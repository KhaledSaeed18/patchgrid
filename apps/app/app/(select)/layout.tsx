/**
 * Authenticated but not yet bound to a tenant — the only place in the product
 * that is. Routes here are `@TenantOptional` on the API and read the caller's
 * workspaces from `UserOrgIndex`, the one projection that answers "which tenants?"
 * before a tenant is known (ADR-0022).
 */
/**
 * Nothing under this group may be statically generated.
 *
 * `apps/app` serves every tenant from one deployment, so the tenant is a
 * request-time value and never a build-time one (ADR-0016). Declaring it on the
 * *layout* means a page added below inherits it — the failure this prevents is a
 * future page that quietly renders one tenant's data into the build output, which
 * would then be served to all of them.
 */
export const dynamic = "force-dynamic"

export default function SelectLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
