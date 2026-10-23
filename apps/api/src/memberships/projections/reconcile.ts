import type { MembershipStatus, OrganizationStatus, Role } from "@patchgrid/contracts"

import type { TokenIndexRow } from "../../platform/repositories/api-token-index.repository"
import type { OrgIndexRow } from "../../platform/repositories/user-org-index.repository"

/** One picker row (ADR-0022), as it should be or as it is. */
export type IndexRow = OrgIndexRow

/** The source the projection derives from: one org, and its human members. */
export type ProjectionSource = {
  org: { slug: string; name: string; status: OrganizationStatus; deletionRequestedAt: Date | null }
  members: { userId: string; role: Role; status: MembershipStatus }[]
}

export type ReconcilePlan = { create: IndexRow[]; update: IndexRow[]; remove: string[] }

/**
 * What `UserOrgIndex` should hold for one org, from its source: a row per
 * human member who is active, disabled or removed — the picker hides a
 * removed one (ADR-0033), and erasure finds it (ADR-0044); an invited one is
 * not on it yet — carrying their role and status and the org's name, slug and status.
 */
export function expectedRows(source: ProjectionSource): IndexRow[] {
  return source.members
    .filter((m) => m.status !== "INVITED")
    .map((m) => ({
      userId: m.userId,
      roleForDisplay: m.role,
      statusForDisplay: m.status,
      orgSlug: source.org.slug,
      orgName: source.org.name,
      orgStatus: source.org.status,
      orgDeletionRequestedAt: source.org.deletionRequestedAt,
    }))
}

/** The writes that make `actual` what `expected` says. Pure; an empty plan means no drift. */
export function planReconcile(expected: readonly IndexRow[], actual: readonly IndexRow[]): ReconcilePlan {
  const have = new Map(actual.map((row) => [row.userId, row]))
  const want = new Set(expected.map((row) => row.userId))
  const plan: ReconcilePlan = { create: [], update: [], remove: [] }
  for (const row of expected) {
    const current = have.get(row.userId)
    if (current === undefined) plan.create.push(row)
    else if (!same(current, row)) plan.update.push(row)
  }
  for (const row of actual) if (!want.has(row.userId)) plan.remove.push(row.userId)
  return plan
}

export function driftOf(plan: { create: readonly unknown[]; update: readonly unknown[]; remove: readonly unknown[] }): number {
  return plan.create.length + plan.update.length + plan.remove.length
}

function same(a: IndexRow, b: IndexRow): boolean {
  return (
    a.roleForDisplay === b.roleForDisplay &&
    a.statusForDisplay === b.statusForDisplay &&
    a.orgSlug === b.orgSlug &&
    a.orgName === b.orgName &&
    a.orgStatus === b.orgStatus &&
    a.orgDeletionRequestedAt?.getTime() === b.orgDeletionRequestedAt?.getTime()
  )
}

export type { TokenIndexRow }

export type TokenReconcilePlan = { create: TokenIndexRow[]; update: TokenIndexRow[]; remove: string[] }

/**
 * The writes that make one org's `ApiTokenIndex` mirror its `ApiToken` rows:
 * one row per token, revoked exactly when the token is. A stray prefix is
 * removed — an index row nothing stands behind resolves a tenant for nobody.
 */
export function planTokenReconcile(tokens: readonly TokenIndexRow[], index: readonly TokenIndexRow[]): TokenReconcilePlan {
  const have = new Map(index.map((row) => [row.prefix, row]))
  const want = new Set(tokens.map((row) => row.prefix))
  const plan: TokenReconcilePlan = { create: [], update: [], remove: [] }
  for (const token of tokens) {
    const current = have.get(token.prefix)
    if (current === undefined) plan.create.push(token)
    else if ((current.revokedAt === null) !== (token.revokedAt === null)) plan.update.push(token)
  }
  for (const row of index) if (!want.has(row.prefix)) plan.remove.push(row.prefix)
  return plan
}
