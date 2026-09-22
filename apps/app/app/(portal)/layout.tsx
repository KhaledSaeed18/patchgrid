/**
 * The requester surface: an employee raising and following their own tickets.
 *
 * A requester never sees an internal note, the audit log, or another person's
 * ticket — enforced in the API by the repository layer, not by what this renders
 * (`docs/RBAC.md` §5).
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

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
