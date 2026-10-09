import { slugSchema } from "@patchgrid/contracts"

/**
 * What a `Host` header means to this deployment (ADR-0014, ADR-0016): `app.`
 * is the tenant-less surface, any other legal slug under the root domain is a
 * workspace, and anything else is not ours to serve. The slug rule is the one
 * the API and the signup form use, so a label this calls a tenant is one the
 * API could resolve.
 */
export type HostKind = { kind: "app" } | { kind: "tenant"; slug: string } | { kind: "foreign" }

export function parseHost(host: string | null, rootDomain: string): HostKind {
  if (host === null) return { kind: "foreign" }
  const hostname = host.toLowerCase().replace(/:\d+$/, "")
  const suffix = `.${rootDomain.toLowerCase()}`
  if (!hostname.endsWith(suffix)) return { kind: "foreign" }
  const label = hostname.slice(0, -suffix.length)
  if (label === "app") return { kind: "app" }
  // The slug schema also refuses reserved labels — `api`, `www`, `admin` are never a workspace.
  if (label.includes(".") || !slugSchema.safeParse(label).success) return { kind: "foreign" }
  return { kind: "tenant", slug: label }
}
