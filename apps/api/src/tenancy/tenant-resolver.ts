import { Inject, Injectable } from "@nestjs/common"

import { assertedSlug, type Located } from "./credential-locator"
import { ORGANIZATION_LOOKUP, type OrganizationLookup } from "./organization-lookup"
import type { OrganizationSummary } from "../platform/repositories/organization.repository"

/**
 * The organization a request is bound to, once the credential and the asserted
 * tenant agree and the organization is in a state that may serve requests.
 */
export type ResolvedTenant = OrganizationSummary & {
  status: "ACTIVE"
  /** Which credential carried the tenant. Auth (step 7) verifies that same credential. */
  via: "bearer" | "cookie"
}

export type Refusal = {
  problem: "not-authenticated" | "tenant-mismatch" | "organization-suspended" | "not-found"
  detail: string
}

export type Resolution = { ok: true; tenant: ResolvedTenant } | { ok: false; refusal: Refusal }

const refuse = (problem: Refusal["problem"], detail: string): Resolution => ({
  ok: false,
  refusal: { problem, detail },
})

/**
 * Pipeline step 4 (ARCHITECTURE.md), as a decision table. The credential
 * carries the tenant; the host corroborates it (ADR-0024):
 *
 *  1. `Authorization: Bearer pg_…` → the token's org. Cookies are ignored.
 *  2. Otherwise the access cookie named by the asserted slug; its `org` claim
 *     is the tenant.
 *  3. An `Origin` must name that same org, else 403.
 *  4. With no `Origin`, `X-Patchgrid-Tenant` must be present and match, else 403.
 *
 * Then the organization's state: unknown 404, suspended 403, pending deletion
 * 404 — before any handler runs. Reads of absent and invisible things look the
 * same (RBAC.md §11), so a slug that does not exist and one that is being
 * deleted are both `404`.
 *
 * Nothing here is trusted: the cookie's claim is unverified and the bearer's
 * secret unchecked. Step 7 does that, exactly once. What step 4 settles is
 * WHICH tenant the rest of the pipeline runs as, which is why a forged claim
 * can only buy what an anonymous slug probe can (threat model R-2).
 */
@Injectable()
export class TenantResolver {
  constructor(@Inject(ORGANIZATION_LOOKUP) private readonly lookup: OrganizationLookup) {}

  async resolve(located: Located): Promise<Resolution> {
    const { credential, assertion } = located

    if (assertion.origin.kind === "foreign") {
      return refuse("tenant-mismatch", "The request's Origin is not a Patchgrid host")
    }

    const slug = assertedSlug(assertion)
    if (slug === null) {
      return refuse("tenant-mismatch", "Origin and X-Patchgrid-Tenant name different workspaces")
    }

    if (credential.kind === "bearer") {
      if (credential.prefix === null) {
        return refuse("not-authenticated", "The bearer token is not a Patchgrid API token")
      }
      const orgId = await this.lookup.orgIdForTokenPrefix(credential.prefix)
      const org = orgId === null ? null : await this.lookup.byId(orgId)
      if (org === null) return refuse("not-authenticated", "Unknown or revoked API token")
      // A token used against another org's subdomain is 403 (ADR-0021).
      if (slug !== undefined && slug !== org.slug) {
        return refuse("tenant-mismatch", "The API token belongs to a different workspace")
      }
      return this.admit(org, "bearer")
    }

    // From here the tenant can only come from a cookie, and a cookie can only
    // be chosen once the request has asserted which workspace it is acting in.
    if (slug === undefined) {
      return refuse(
        "tenant-mismatch",
        assertion.origin.kind === "infrastructure"
          ? "This route is bound to a workspace; the Origin is not one"
          : "X-Patchgrid-Tenant is required when Origin is absent",
      )
    }

    if (credential.kind === "none") {
      // Unauthenticated against a named workspace: say whether the workspace
      // exists and may serve, then that a session is needed.
      const org = await this.lookup.bySlug(slug)
      if (org === null) return refuse("not-found", "Unknown workspace")
      const state = stateRefusal(org)
      return state ?? refuse("not-authenticated", "A session is required")
    }

    if (credential.orgId === null) {
      return refuse("not-authenticated", "The session cookie is unreadable")
    }
    const org = await this.lookup.byId(credential.orgId)
    if (org === null) return refuse("not-authenticated", "The session names a workspace that does not exist")
    // The cookie was named by `slug`; its claim must agree. A tossed, forged or
    // stale cookie does not, and never selects the tenant (ADR-0024 §2–3).
    if (org.slug !== slug) {
      return refuse("tenant-mismatch", "The session belongs to a different workspace")
    }
    return this.admit(org, "cookie")
  }

  private admit(org: OrganizationSummary, via: ResolvedTenant["via"]): Resolution {
    const state = stateRefusal(org)
    if (state !== null) return state
    return { ok: true, tenant: { ...org, status: "ACTIVE", via } }
  }
}

function stateRefusal(org: OrganizationSummary): Resolution | null {
  switch (org.status) {
    case "ACTIVE":
      return null
    case "SUSPENDED":
      return refuse("organization-suspended", "This workspace is suspended")
    case "PENDING_DELETION":
      // Indistinguishable from "never existed", on purpose: the subdomain 404s.
      return refuse("not-found", "Unknown workspace")
  }
}
