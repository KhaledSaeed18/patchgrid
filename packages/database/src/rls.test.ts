import { describe, expect, it } from "vitest"

import { tenantPolicySql } from "./rls.ts"

describe("tenantPolicySql", () => {
  it("enables and FORCES row security, then filters and checks on orgId", () => {
    expect(tenantPolicySql("Team")).toBe(
      [
        `ALTER TABLE "Team" ENABLE ROW LEVEL SECURITY;`,
        `ALTER TABLE "Team" FORCE ROW LEVEL SECURITY;`,
        `CREATE POLICY tenant_isolation ON "Team"`,
        `  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)`,
        `  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);`,
      ].join("\n"),
    )
  })

  it("refuses anything that is not a plain model name", () => {
    expect(() => tenantPolicySql(`Team"; DROP TABLE "User`)).toThrow()
    expect(() => tenantPolicySql("team")).toThrow()
  })
})
