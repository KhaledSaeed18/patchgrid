/**
 * Google's issuer is shared by every Google account in the world: any of them
 * can complete a sign-in through a workspace's Google client, and Google sets
 * `email_verified` for an address at `acme.test` whether or not Acme's Google
 * Workspace manages it (an unmanaged account made with that address). The
 * `hd` claim is what says Acme's Workspace does — so for this issuer it must
 * name the proved domain (ADR-0054 erratum, 2026-10-23).
 *
 * Other issuers are the workspace's own, single-tenant by assumption; they
 * send no `hd` and are not asked for one.
 */
const SHARED_ISSUERS: ReadonlySet<string> = new Set(["https://accounts.google.com", "accounts.google.com"])

export function requiresHostedDomain(issuer: string): boolean {
  return SHARED_ISSUERS.has(issuer.replace(/\/+$/, "").toLowerCase())
}

/** Whether the provider's hosted-domain claim lets this sign-in through for `domain`. */
export function hostedDomainAdmits(issuer: string, hostedDomain: string | null, domain: string): boolean {
  if (!requiresHostedDomain(issuer)) return true
  return hostedDomain !== null && hostedDomain.toLowerCase() === domain.toLowerCase()
}
