import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  type Grant,
  grantFor,
  isPermission,
  PERMISSION_MATRIX,
  type Permission,
  PERMISSIONS,
  SCOPE_GRANTS,
  TOKEN_FORBIDDEN_FAMILIES,
  type TokenScope,
  tokenScopeSchema,
} from "./permissions.ts"
import { roleSchema } from "./tenancy.ts"

/**
 * RBAC.md §6 says the catalog and the matrix are one table. This holds the
 * code to the document: every permission row there is a key here with the same
 * grant per role, and nothing exists here that the document does not describe.
 * A cell whose wording is not in CELLS fails loudly — teach it the new wording
 * rather than loosening the parse.
 */

const RBAC = readFileSync(new URL("../../../docs/RBAC.md", import.meta.url), "utf8")
const ROLES = roleSchema.options.toReversed() // REQUESTER, AGENT, ADMIN, OWNER — the column order

const CELLS: Record<string, Grant> = {
  "✅": true,
  "—": false,
  own: ["own"],
  "own, watch": ["own", "watch"],
  "own, watch (public only)": ["own", "watch"],
  "own, while `NEW`": ["own_while_new"],
  "own: cancel from `NEW`, close from `RESOLVED`, reopen": ["own"],
  "own drafts": ["own"],
  "own uploads": ["own"],
  "own, within 15 min": ["own_within_window"],
  "`ownerMembershipId = self`": ["own"],
  scope: ["scope"],
  "`lead`": ["lead"],
  "`lead`, never own change": ["lead_not_own"],
  "`self`": ["self"],
  "✅, never own": ["not_own"],
  "✅, never own (except the documented last-approver case, `DOMAIN.md` §2.3)": ["not_own"],
  "✅ (below `ADMIN`, never own)": ["below_admin_not_self"],
  "✅ (not Owners, never own)": ["not_owner_not_self"],
}

type DocRow = { names: Permission[]; qualifier: string; grants: Grant[] }

function cells(line: string): string[] {
  return line.split("|").slice(1, -1).map((c) => c.trim())
}

function documentedRows(): DocRow[] {
  const section = RBAC.slice(RBAC.indexOf("## 6."), RBAC.indexOf("## 7."))
  const rows: DocRow[] = []
  let inTable = false
  for (const line of section.split("\n")) {
    if (line.startsWith("| Permission |")) {
      inTable = true
      continue
    }
    if (!line.startsWith("|")) {
      inTable = false
      continue
    }
    if (!inTable || line.startsWith("| ---")) continue
    const [first = "", ...roleCells] = cells(line)
    const names = [...first.matchAll(/`([a-z_]+:[a-z_]+)`/g)].map((m) => m[1] ?? "")
    for (const name of names) {
      if (!isPermission(name)) throw new Error(`RBAC.md names an unknown permission: ${name}`)
    }
    const qualifier = first.replace(/`[^`]+`/g, "").replace(/[/\s]+/g, " ").trim()
    const grants = roleCells.map((text) => {
      const grant = CELLS[text]
      if (grant === undefined) throw new Error(`Unrecognised matrix cell in RBAC.md: "${text}"`)
      return grant
    })
    rows.push({ names: names as Permission[], qualifier, grants })
  }
  return rows
}

/** The 15-minute window lives in the permission's qualifier, not in its cells. */
function windowed(grant: Grant, qualifier: string): Grant {
  if (!qualifier.includes("15 min window") || typeof grant === "boolean") return grant
  return grant.map((c) => (c === "self" ? "self_within_window" : c)) as unknown as Grant
}

function documentedMatrix(): Map<Permission, Grant[]> {
  const matrix = new Map<Permission, Grant[]>()
  for (const row of documentedRows()) {
    for (const name of row.names) {
      const grants = row.grants.map((g) => windowed(g, row.qualifier))
      const previous = matrix.get(name)
      // `ticket:create` is two rows split by ticket type: a role allowed on the
      // first (Incident, Service Request) but not the second holds it only for
      // the user-facing types.
      matrix.set(
        name,
        previous === undefined
          ? grants
          : previous.map((g, i): Grant => {
              const other = grants[i]
              if (g === true && other === true) return true
              if (g === true && other === false) return ["user_facing_type"]
              if (g === false && other === false) return false
              throw new Error(`Cannot merge split rows for ${name}`)
            }),
      )
    }
  }
  return matrix
}

describe("the permission matrix", () => {
  const documented = documentedMatrix()

  it("covers exactly the permissions RBAC.md §6 lists", () => {
    expect([...documented.keys()].toSorted()).toEqual([...PERMISSIONS].toSorted())
  })

  it.each(PERMISSIONS)("%s grants what RBAC.md says, role by role", (permission) => {
    const expected = documented.get(permission)
    expect(ROLES.map((role) => grantFor(role, permission))).toEqual(expected)
  })

  it("is cumulative: whatever a role may ever do, every higher role may too", () => {
    for (const permission of PERMISSIONS) {
      const grants = ROLES.map((role) => PERMISSION_MATRIX[permission][role])
      grants.forEach((grant, i) => {
        const higher = grants.slice(i + 1)
        if (grant === true) expect(higher.every((g) => g === true), permission).toBe(true)
        if (grant !== false) expect(higher.every((g) => g !== false), permission).toBe(true)
      })
    }
  })

  it("rejects anything outside the catalog", () => {
    expect(isPermission("ticket:read")).toBe(true)
    expect(isPermission("ticket:obliterate")).toBe(false)
    expect(isPermission("toString")).toBe(false)
  })
})

describe("token scopes", () => {
  function documentedScopes(): Map<string, string[]> {
    const section = RBAC.slice(RBAC.indexOf("## 10."), RBAC.indexOf("## 11."))
    const map = new Map<string, string[]>()
    for (const line of section.split("\n")) {
      if (!line.startsWith("| `")) continue
      const [scopeCell = "", grantCell = ""] = cells(line)
      const scopes = scopeCell.split(" / ").map((s) => s.replaceAll("`", "").trim())
      const grantParts = grantCell.split(" / ")
      scopes.forEach((scope, i) => {
        const part = grantParts.length === scopes.length ? (grantParts[i] ?? "") : grantCell
        map.set(scope, [...part.matchAll(/`([a-z_]+:[a-z_]+)`/g)].map((m) => m[1] ?? ""))
      })
    }
    return map
  }

  it("maps every scope exactly as RBAC.md §10 does", () => {
    const documented = documentedScopes()
    expect([...documented.keys()].toSorted()).toEqual([...tokenScopeSchema.options].toSorted())
    for (const scope of tokenScopeSchema.options) {
      expect([...SCOPE_GRANTS[scope]].toSorted(), scope).toEqual(documented.get(scope)?.toSorted())
    }
  })

  it("never reaches a forbidden family, whatever the scopes", () => {
    const reachable = Object.values(SCOPE_GRANTS).flat()
    for (const family of TOKEN_FORBIDDEN_FAMILIES) {
      expect(reachable.filter((p) => p.startsWith(`${family}:`))).toEqual([])
    }
  })

  it("keeps internal comments behind their own opt-in scope", () => {
    const holders = (Object.keys(SCOPE_GRANTS) as TokenScope[]).filter((s) =>
      (SCOPE_GRANTS[s] as readonly string[]).includes("comment:read_internal"),
    )
    expect(holders).toEqual(["comments:internal"])
  })
})
