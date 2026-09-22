/**
 * Slugs a tenant may never claim.
 *
 * **This is the only definition.** It was previously restated in three documents,
 * which is how `inbound` — the hostname carrying every tenant's email intake —
 * ended up absent from the list while being in active use.
 *
 * The rule that keeps it correct: **any PR that introduces a new public hostname
 * adds its label here in the same PR.** The DNS zone and this set are two halves
 * of one decision (`docs/DNS.md` §1) — a label that exists in DNS but not here can
 * be claimed by a customer, and their workspace and our infrastructure then shadow
 * each other.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Product surfaces — these are real hosts today
  "www", "app", "api", "admin", "files", "inbound",

  // Reserved for surfaces we have named but not built
  "status", "docs", "help", "support", "portal", "billing", "account", "accounts",

  // Certificate and platform machinery
  "renewal-canary", "well-known", "health", "metrics", "ops", "grafana", "internal",

  // Mail and DNS labels: claiming one of these would shadow real infrastructure
  "mail", "smtp", "imap", "ns1", "ns2", "email",
  "autodiscover", "autoconfig", "dmarc", "dkim", "spf",

  // Content and asset hosts
  "cdn", "static", "assets", "media", "img", "attachments",

  // Environments — a tenant named `staging` makes every runbook ambiguous
  "staging", "stage", "dev", "test", "demo", "sandbox", "preview", "local",

  // Authentication paths
  "auth", "login", "logout", "signup", "register", "sso", "oauth", "oidc", "saml",

  // Marketing and legal pages
  "about", "blog", "legal", "privacy", "terms", "security", "pricing", "contact",

  // Brand: a tenant must not be able to look like us
  "patchgrid", "official", "team", "staff", "root", "system",

  // Webhook endpoints, reserved before they exist
  "webhook", "webhooks",
])

/**
 * Deliberately absent: `mx`, `ns`, `go`, `my`, `id`, and any other label shorter
 * than three characters. The minimum slug length already makes them unclaimable,
 * so listing them would be dead weight that hides a typo in a real entry — which
 * is what the "every reserved entry is a well-formed slug" test exists to catch.
 */

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase())
}
