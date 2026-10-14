import { INBOUND_SUBDOMAIN } from "@patchgrid/contracts"

/**
 * The slug a recipient addresses (ADR-0039): `acme@inbound.<root>`, or
 * `acme+anything@…` — a sub-address still names Acme. Anything at another
 * host is not ours to resolve.
 */
export function slugFromRecipient(address: string, rootDomain: string): string | null {
  const [local, host] = address.trim().toLowerCase().split("@")
  if (local === undefined || host === undefined || host !== `${INBOUND_SUBDOMAIN}.${rootDomain.toLowerCase()}`) return null
  const slug = local.split("+")[0] ?? ""
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) ? slug : null
}
