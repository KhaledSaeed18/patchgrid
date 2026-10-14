import { Injectable } from "@nestjs/common"
import {
  decodeCursor,
  emailWanted,
  encodeCursor,
  type Notification,
  type NotificationListQuery,
  type NotificationPage,
  type NotificationPreferences,
  notificationTypeSchema,
  type UpdateNotificationPreferences,
} from "@patchgrid/contracts"

import { ActorService, type MemberActor } from "../auth/actor"
import { PermissionService } from "../authz/permission.service"
import { type Clock, InjectClock } from "../common/clock/clock"
import { NotFoundProblem, NotPermittedProblem, ValidationProblem } from "../common/problems/problem.exception"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { NotificationPreferencesRepository } from "./repositories/notification-preferences.repository"
import { NotificationRepository, type NotificationRow } from "./repositories/notification.repository"

/**
 * The member's own inbox in this workspace (DOMAIN.md §8). Everything here is
 * `self`: no role reads or marks another member's notifications, and a
 * service account has no inbox at all.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly preferences: NotificationPreferencesRepository,
    private readonly permissions: PermissionService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async list(query: NotificationListQuery): Promise<NotificationPage> {
    const actor = this.self("notification:read")
    const orgId = this.tenant.requireOrgId()
    let after: { updatedAt: Date; id: string } | null = null
    if (query.cursor !== undefined) {
      const parts = decodeCursor(query.cursor)
      const updatedAt = parts === null ? null : new Date(parts.sortValue)
      if (parts === null || updatedAt === null || Number.isNaN(updatedAt.getTime())) {
        throw new ValidationProblem([{ path: "cursor", message: "is not a cursor this endpoint issued", code: "invalid_cursor" }])
      }
      after = { updatedAt, id: parts.id }
    }
    const { rows, unreadCount } = await this.notifications.page(orgId, actor.userId, { unread: query.unread, after, limit: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toNotification),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ sortValue: last.updatedAt.toISOString(), id: last.id })
          : null,
      unreadCount,
    }
  }

  async markRead(id: string): Promise<void> {
    const actor = this.self("notification:update")
    if (!(await this.notifications.markRead(this.tenant.requireOrgId(), actor.userId, id, this.clock.now()))) {
      throw new NotFoundProblem()
    }
  }

  async markAllRead(): Promise<void> {
    const actor = this.self("notification:update")
    await this.notifications.markAllRead(this.tenant.requireOrgId(), actor.userId, this.clock.now())
  }

  /** The member's email choices in this workspace, every type spelled out (DOMAIN.md §8). */
  async readPreferences(): Promise<NotificationPreferences> {
    const actor = this.self("notification:read")
    const stored = await this.preferences.read(this.tenant.requireOrgId(), actor.membershipId)
    if (stored === null) throw new NotFoundProblem()
    return { emailEnabledForOrg: stored.orgEnabled, email: spelledOut(stored.prefs) }
  }

  async updatePreferences(request: UpdateNotificationPreferences): Promise<NotificationPreferences> {
    const actor = this.self("notification:update")
    const orgId = this.tenant.requireOrgId()
    const stored = await this.preferences.merge(orgId, actor.membershipId, request.email)
    if (stored === null) throw new NotFoundProblem()
    return { emailEnabledForOrg: stored.orgEnabled, email: spelledOut(stored.prefs) }
  }

  private self(permission: "notification:read" | "notification:update"): MemberActor {
    const actor = this.actors.requireTenantActor()
    this.permissions.assert(actor, permission, { self: true })
    if (actor.kind !== "member") throw new NotPermittedProblem()
    return actor
  }
}

export function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    ticketId: row.ticketId,
    count: row.count,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function spelledOut(prefs: Parameters<typeof emailWanted>[0]): NotificationPreferences["email"] {
  return Object.fromEntries(notificationTypeSchema.options.map((type) => [type, emailWanted(prefs, type)])) as NotificationPreferences["email"]
}
