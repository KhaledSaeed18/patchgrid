/**
 * The docs and the blog, as data: what exists, in what order, and what each
 * page is called. The MDX files hold only the prose (ADR-0016) — the pages, the
 * sitemap, the Open Graph images and the JSON-LD all read their titles from
 * here, so a page has one name everywhere. `content.test.ts` holds the two in
 * step: every entry has its file and every file its entry.
 */

export type DocSection = "Start" | "Using Patchgrid" | "Building on it"

export type Doc = {
  readonly slug: string
  readonly title: string
  /** One sentence; the meta description and the index card. */
  readonly description: string
  readonly section: DocSection
}

export type Post = {
  readonly slug: string
  readonly title: string
  readonly description: string
  /** `YYYY-MM-DD`, the day it was published. */
  readonly date: string
}

export const DOC_SECTIONS: readonly DocSection[] = [
  "Start",
  "Using Patchgrid",
  "Building on it",
]

/** In reading order: the sidebar, the index and previous/next follow it. */
export const DOCS: readonly Doc[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    description:
      "Create a Patchgrid workspace, choose its address, invite your team, sign in, and work across several workspaces from one account.",
    section: "Start",
  },
  {
    slug: "tickets",
    title: "Tickets and their lifecycles",
    description:
      "Incidents, service requests, problems and changes: their numbers, lifecycles, approvals, comments, watchers, links and the reopening window.",
    section: "Using Patchgrid",
  },
  {
    slug: "priority-and-slas",
    title: "Priority and SLAs",
    description:
      "How Patchgrid computes priority from impact and urgency, the default SLA targets, 24x7 clocks, the pending pause, and warnings and breaches.",
    section: "Using Patchgrid",
  },
  {
    slug: "roles-and-permissions",
    title: "Roles and permissions",
    description:
      "Requester, Agent, Admin and Owner, team leads, agent visibility, not found versus not permitted, two-factor authentication and step-up checks.",
    section: "Using Patchgrid",
  },
  {
    slug: "knowledge-base-and-assets",
    title: "Knowledge base and assets",
    description:
      "Write and publish knowledge-base articles in three visibility tiers, keep an asset register, and link assets to the tickets about them.",
    section: "Using Patchgrid",
  },
  {
    slug: "email",
    title: "Email",
    description:
      "Raise and reply to tickets by email: your inbound address, DMARC sender checks, threading by ticket number, the inbound log and notification email.",
    section: "Using Patchgrid",
  },
  {
    slug: "api",
    title: "The API",
    description:
      "The Patchgrid REST API: scoped API tokens, Problem Details errors, cursor pagination, versioned writes, Idempotency-Key, transitions and OpenAPI.",
    section: "Building on it",
  },
  {
    slug: "webhooks",
    title: "Webhooks",
    description:
      "Outbound webhooks: the event catalogue, the payload, verifying the Standard Webhooks signature, retries, the circuit breaker, replay and secret rotation.",
    section: "Building on it",
  },
  {
    slug: "security-and-data",
    title: "Security and your data",
    description:
      "How Patchgrid isolates workspaces, consent-based support access, the audit log, data export, account erasure and workspace deletion.",
    section: "Building on it",
  },
]

/** Newest first. */
export const POSTS: readonly Post[] = [
  {
    slug: "what-a-security-review-found",
    title: "What a security review found",
    description:
      "Three independent reviews, sixteen confirmed findings: budgets strangers could spend, bearer capabilities in the wrong channel, and step-up gaps.",
    date: "2026-10-16",
  },
  {
    slug: "priority-is-computed",
    title: "Priority is computed, never chosen",
    description:
      "Priority is derived from impact × urgency and a client-sent priority is a 400. How SLA deadlines, the pending pause and 24×7 clocks follow from it.",
    date: "2026-10-09",
  },
  {
    slug: "foreign-keys-that-leak",
    title: "Foreign keys that leak",
    description:
      "PostgreSQL checks foreign keys with row security off, so a tenanted row can point at another tenant's. Composite (orgId, id) keys make it unrepresentable.",
    date: "2026-10-09",
  },
  {
    slug: "the-tenant-comes-from-the-credential",
    title: "The tenant comes from the credential, not the Host",
    description:
      "Why Patchgrid reads the tenant from the access or API token, not the Host or a body field, and why set_config must stay transaction-local.",
    date: "2026-10-05",
  },
]

export const findDoc = (slug: string): Doc | undefined =>
  DOCS.find((d) => d.slug === slug)
export const findPost = (slug: string): Post | undefined =>
  POSTS.find((p) => p.slug === slug)

/** The pages either side of a doc, in reading order. */
export function neighbours(slug: string): { previous?: Doc; next?: Doc } {
  const index = DOCS.findIndex((d) => d.slug === slug)
  if (index === -1) return {}
  const previous = DOCS[index - 1]
  const next = DOCS[index + 1]
  return { ...(previous && { previous }), ...(next && { next }) }
}

/** "16 October 2026" — written out, so no reader has to guess the order. */
export const formatDate = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
