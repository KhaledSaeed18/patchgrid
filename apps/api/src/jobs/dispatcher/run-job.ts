import process from "node:process"

import { runAsPlatform } from "../../platform/run-as-platform"
import { runAsTenant } from "../../platform/run-as-tenant"
import { isRlsDenied, recordJob, recordRlsDenied, tagActiveSpanWithTenant } from "../../telemetry/metrics"

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
export async function runJob<T>(
  payload: TenantScoped,
  actor: string,
  reason: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Duration and outcome per queue and tenant (ADR-0030): whether one tenant is starving the others.
  const started = process.hrtime.bigint()
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1_000_000
  tagActiveSpanWithTenant({ orgId: payload.orgId ?? undefined, actorKind: "job" })
  try {
    const result =
      payload.orgId === null
        ? await runAsPlatform({ actor, reason }, fn)
        : await runAsTenant(payload.orgId, { actor, reason }, fn)
    recordJob({ queue: actor, orgId: payload.orgId, outcome: "completed", durationMs: elapsed() })
    return result
  } catch (error) {
    if (isRlsDenied(error)) recordRlsDenied(payload.orgId)
    recordJob({ queue: actor, orgId: payload.orgId, outcome: "failed", durationMs: elapsed() })
    throw error
  }
}
