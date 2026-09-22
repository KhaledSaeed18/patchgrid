/**
 * Workspace configuration: members, teams, categories, SLA policies, automation.
 *
 * Hiding a control here is a convenience. The API is the authority, and every one
 * of these routes asserts a permission in its service (`docs/RBAC.md` §1).
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

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
