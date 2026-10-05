import { runAsPlatform } from "../../platform/run-as-platform"
import { runAsTenant } from "../../platform/run-as-tenant"

/** Every job payload says which tenant it belongs to — or that it belongs to none. */
export type TenantScoped = { orgId: string | null }

/**
 * The processor wrapper (ADR-0018): a job runs in exactly the context a request
 * would, so repositories, RLS and audit logging behave identically. A payload
 * with an org runs inside that tenant; one without runs platform-only and can
 * reach only platform-class tables. Processors call this and never the
 * crossing helpers themselves: `src/jobs/dispatcher` is the one place in the
 * jobs tree allowed to run with no tenant at all (ADR-0022), so the wrapper
 * that decides between the two lives here.
 */
export function runJob<T>(
  payload: TenantScoped,
  actor: string,
  reason: string,
  fn: () => Promise<T>,
): Promise<T> {
  return payload.orgId === null
    ? runAsPlatform({ actor, reason }, fn)
    : runAsTenant(payload.orgId, { actor, reason }, fn)
}
