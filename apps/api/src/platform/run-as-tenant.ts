import { idSchema } from "@patchgrid/contracts"

import { type Crossing, crossingLogger, requestContext } from "./crossing"

/**
 * Runs `fn` with the tenant context of an organization the current request —
 * if there is one — is not bound to (ADR-0022).
 *
 * This is NOT a bypass. It points the ordinary mechanism at a known org: the
 * client extension sets `app.current_org_id = orgId`, RLS filters and
 * constrains every row for that org, and repositories behave exactly as they
 * would in a request. Per-tenant jobs, provisioning, support-session reads,
 * org purge and platform-admin actions on tenant content all run here.
 *
 * The callback runs in a child context: the tenant and any open transaction
 * of the caller are hidden from it and restored when it returns. Await inside
 * `fn` — Prisma promises are lazy, and one awaited after `fn` returns sees no
 * tenant and throws.
 *
 * Importable only by `src/platform`, `src/auth`, `src/jobs` and
 * `src/orgs/provisioning`; the linter enforces it.
 */
export async function runAsTenant<T>(
  orgId: string,
  crossing: Crossing,
  fn: () => Promise<T>,
): Promise<T> {
  // A malformed id would reach `set_config` and make the policy's `::uuid`
  // cast raise on every query. Fail here, with a message that names the bug.
  const parsed = idSchema.safeParse(orgId)
  if (!parsed.success) {
    throw new TypeError(`runAsTenant: orgId ${JSON.stringify(orgId)} is not a UUID`)
  }

  const cls = requestContext()
  const from = cls.isActive() ? (cls.get("tenant")?.orgId ?? "platform") : "none"
  crossingLogger.log({
    msg: "runAsTenant",
    orgId: parsed.data,
    from,
    actor: crossing.actor,
    reason: crossing.reason,
  })

  return cls.run({ ifNested: "inherit" }, async () => {
    cls.set("tenant", { orgId: parsed.data, inTransaction: false })
    cls.set("prismaTransaction", undefined)
    return await fn()
  })
}
