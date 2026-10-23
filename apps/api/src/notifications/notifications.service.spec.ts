import { type EmailPrefs, notificationTypeSchema, type Role } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"

import type { ActorService, TenantActor } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { FixedClock } from "../common/clock/clock"
import { NotFoundProblem, NotPermittedProblem, ValidationProblem } from "../common/problems/problem.exception"
import type { TenantContextService } from "../tenancy/tenant-context.service"
import { NotificationsService } from "./notifications.service"
import type { NotificationPreferencesRepository } from "./repositories/notification-preferences.repository"
import type { NotificationRepository, NotificationRow } from "./repositories/notification.repository"

const NOW = new Date("2026-10-09T12:00:00Z")
const row = (id: string, minute: number): NotificationRow => ({
  id,
  type: "COMMENT_PUBLIC",
  title: "New reply",
  body: null,
  ticketId: null,
  count: 1,
  readAt: null,
  createdAt: new Date(NOW.getTime() - minute * 60_000),
  updatedAt: NOW,
})

function harness(actor: TenantActor, rows: NotificationRow[] = []) {
  const repo = {
    page: vi.fn(async () => ({ rows, unreadCount: 7 })),
    markRead: vi.fn(async (_o: string, _u: string, id: string) => id === "mine"),
    markAllRead: vi.fn(async () => 2),
  }
  const prefs = {
    stored: { prefs: { SLA_WARNING: false } as EmailPrefs, orgEnabled: false },
    read: vi.fn(async () => prefs.stored),
    merge: vi.fn(async (_o: string, _m: string, patch: EmailPrefs) => {
      prefs.stored = { ...prefs.stored, prefs: { ...prefs.stored.prefs, ...patch } }
      return prefs.stored
    }),
  }
  const service = new NotificationsService(
    repo as unknown as NotificationRepository,
    prefs as unknown as NotificationPreferencesRepository,
    new PermissionService(),
    { requireTenantActor: () => actor } as unknown as ActorService,
    { requireOrgId: () => "o-1" } as unknown as TenantContextService,
    new FixedClock(NOW),
  )
  return { service, repo, prefs }
}

const member = (role: Role): TenantActor => ({ kind: "member", userId: "u-1", orgId: "o-1", membershipId: "m-1", role, teamIds: [], leadOfTeamIds: [] })

describe("NotificationsService", () => {
  it("reads the caller's own inbox by user, pages it, and counts the unread beside it", async () => {
    const h = harness(member("REQUESTER"), [row("a", 1), row("b", 2), row("c", 3)])
    const page = await h.service.list({ unread: true, limit: 2 })
    expect(h.repo.page).toHaveBeenCalledWith("o-1", "u-1", { unread: true, after: null, limit: 3 })
    expect(page.items.map((n) => n.id)).toEqual(["a", "b"])
    expect(page.nextCursor).not.toBeNull()
    expect(page.unreadCount).toBe(7)
  })

  it("pages on the last row's updatedAt — a fold moves it — and refuses a cursor it did not issue", async () => {
    const h = harness(member("AGENT"), [row("a", 1), row("b", 2)])
    const first = await h.service.list({ unread: false, limit: 1 })
    await h.service.list({ unread: false, limit: 1, cursor: first.nextCursor ?? "" })
    expect(h.repo.page).toHaveBeenLastCalledWith("o-1", "u-1", { unread: false, after: { updatedAt: NOW, id: "a" }, limit: 2 })
    await expect(h.service.list({ unread: false, limit: 1, cursor: "nonsense" })).rejects.toBeInstanceOf(ValidationProblem)
  })

  it("is a 404 to mark someone else's notification read", async () => {
    const h = harness(member("OWNER"))
    await expect(h.service.markRead("theirs")).rejects.toBeInstanceOf(NotFoundProblem)
    await expect(h.service.markRead("mine")).resolves.toBeUndefined()
    expect(h.repo.markRead).toHaveBeenCalledWith("o-1", "u-1", "mine", NOW)
  })

  it("gives a service account no inbox", async () => {
    const service: TenantActor = { kind: "service", orgId: "o-1", membershipId: "m-svc", role: "AGENT", scopes: ["tickets:read"], tokenId: "t" } as unknown as TenantActor
    await expect(harness(service).service.list({ unread: false, limit: 25 })).rejects.toBeInstanceOf(NotPermittedProblem)
  })

  it("spells out every type, on unless turned off, beside the workspace's switch", async () => {
    const h = harness(member("REQUESTER"))
    const read = await h.service.readPreferences()
    expect(read.emailEnabledForOrg).toBe(false)
    expect(read.email.SLA_WARNING).toBe(false)
    // Every type but the one turned off.
    expect(Object.values(read.email).filter((on) => on)).toHaveLength(notificationTypeSchema.options.length - 1)
    expect(h.prefs.read).toHaveBeenCalledWith("o-1", "m-1")
  })

  it("merges a change into the member's own choices only", async () => {
    const h = harness(member("AGENT"))
    const after = await h.service.updatePreferences({ email: { COMMENT_PUBLIC: false, SLA_WARNING: true } })
    expect(h.prefs.merge).toHaveBeenCalledWith("o-1", "m-1", { COMMENT_PUBLIC: false, SLA_WARNING: true })
    expect(after.email).toMatchObject({ COMMENT_PUBLIC: false, SLA_WARNING: true })
  })
})
