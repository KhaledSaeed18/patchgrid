/**
 * The agent surface: queues, triage, and the ticket thread.
 *
 * What an agent may see depends on `Organization.agentVisibility`, applied once as
 * a scope filter the list repositories consume — never re-derived here
 * (`docs/RBAC.md` §4).
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

export default function ConsoleLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
