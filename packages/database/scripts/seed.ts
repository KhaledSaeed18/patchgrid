/**
 * Development and demo seed.
 *
 * Creates TWO organizations with deliberately similar data — same category
 * names, overlapping ticket titles, same team names — plus one user who is a
 * member of both with different roles. That similarity is the point: it is what
 * makes an isolation bug visible immediately rather than plausible-looking
 * (TENANCY.md §10).
 *
 * Empty until M1 introduces the models.
 */
import process from "node:process"

async function main(): Promise<void> {
  console.log("seed: no models yet — organizations and memberships land in M1")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
