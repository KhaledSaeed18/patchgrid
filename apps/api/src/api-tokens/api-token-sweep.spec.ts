import { describe, expect, it, vi } from "vitest"

import { FixedClock } from "../common/clock/clock"
import type { PublicUrls } from "../common/urls"
import type { MailService } from "../mail/mail.service"
import type { OrganizationRepository } from "../platform/repositories/organization.repository"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { ApiTokenSweepService } from "./api-token-sweep"
import type { ApiTokenRepository } from "./repositories/api-token.repository"

const ORG = "o-1"
const NOW = new Date("2026-10-15T12:00:00Z")
const LAPSES = new Date("2026-10-20T12:00:00Z")

function harness(due: { id: string; expiresAt: Date | null }[], alreadyWarned: string[] = []) {
  const tokens = {
    expiringUnwarned: vi.fn(async () => due.map((t) => ({ ...t, name: "Monitoring", prefix: "abcdefabcdef", createdByMembershipId: "m-admin" }))),
    markWarned: vi.fn(async (_o: string, id: string) => !alreadyWarned.includes(id)),
    warningAddresses: vi.fn(async () => ["alice@acme.test"]),
  }
  const organizations = { findProfileById: vi.fn(async () => ({ name: "Acme", slug: "acme" })) }
  const mail = { enqueueAll: vi.fn(async () => undefined) }
  const service = new ApiTokenSweepService(
    tokens as unknown as ApiTokenRepository,
    organizations as unknown as OrganizationRepository,
    mail as unknown as MailService,
    { workspace: (slug: string, path: string) => `https://${slug}.patchgrid.test${path}` } as unknown as PublicUrls,
    { requireOrgId: () => ORG } as unknown as TenantContextService,
    new FixedClock(NOW),
  )
  return { service, tokens, organizations, mail }
}

describe("ApiTokenSweepService", () => {
  it("looks a week ahead and warns about each lapsing token once, by email to whoever should act", async () => {
    const h = harness([{ id: "t-1", expiresAt: LAPSES }, { id: "t-2", expiresAt: LAPSES }], ["t-2"])
    expect(await h.service.sweep()).toBe(1)
    expect(h.tokens.expiringUnwarned).toHaveBeenCalledWith(ORG, NOW, new Date("2026-10-22T12:00:00Z"))
    expect(h.mail.enqueueAll).toHaveBeenCalledTimes(1)
    expect(h.mail.enqueueAll).toHaveBeenCalledWith([
      expect.objectContaining({
        entityId: "t-1.expiring.0",
        job: expect.objectContaining({
          kind: "api-token-expiring",
          to: "alice@acme.test",
          params: expect.objectContaining({ tokenName: "Monitoring", settingsUrl: "https://acme.patchgrid.test/settings/api-tokens" }),
        }),
      }),
    ])
  })

  it("does nothing, and reads nothing more, when nothing is due", async () => {
    const h = harness([])
    expect(await h.service.sweep()).toBe(0)
    expect(h.organizations.findProfileById).not.toHaveBeenCalled()
  })

  it("still counts a token warned when its mail cannot be queued; the settings list says when it lapses", async () => {
    const h = harness([{ id: "t-1", expiresAt: LAPSES }])
    h.mail.enqueueAll.mockRejectedValueOnce(new Error("redis down"))
    expect(await h.service.sweep()).toBe(1)
  })
})
