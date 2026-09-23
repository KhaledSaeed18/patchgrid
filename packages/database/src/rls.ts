/**
 * The one RLS policy template (TENANCY.md §7, ADR-0015). Every tenant-owned table
 * gets exactly this, in the migration that creates it:
 *
 *   pnpm --filter @patchgrid/database run policy <Table> [<Table> …]
 *
 * prints the SQL to append. `pnpm test:schema` then asserts the policy that is
 * actually in the database matches this template, so a hand-edited variant fails.
 *
 * Why each part:
 *  · FORCE — the table owner is otherwise exempt; only BYPASSRLS roles should be
 *  · USING — filters reads, updates and deletes
 *  · WITH CHECK — refuses writing a row into another tenant
 *  · NULLIF(…, '') — an unset GUC yields NULL and filters everything (fail-closed);
 *    an EMPTY string would otherwise raise `invalid input syntax for type uuid`
 *    and turn every query into a 500 (ADR-0015 erratum)
 *  · current_setting(…, true) — missing_ok, so "no context" is NULL, not an error
 */
export const TENANT_POLICY_NAME = "tenant_isolation"

export const TENANT_POLICY_EXPRESSION =
  `"orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid`

export function tenantPolicySql(table: string): string {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(table)) {
    throw new Error(`Refusing to generate a policy for ${JSON.stringify(table)}`)
  }
  const t = `"${table}"`
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY ${TENANT_POLICY_NAME} ON ${t}`,
    `  USING      (${TENANT_POLICY_EXPRESSION})`,
    `  WITH CHECK (${TENANT_POLICY_EXPRESSION});`,
  ].join("\n")
}
