import { Injectable, Logger } from "@nestjs/common"
import { purgeDateFor } from "@patchgrid/contracts"

import { ActorService } from "../../auth/actor"
import { StepUpService } from "../../auth/mfa/step-up.service"
import { orgEpochKey, RevocationEpochService } from "../../auth/revocation/revocation-epoch.service"
import { AuditService } from "../../audit/audit.service"
import { PermissionService } from "../../authz/permission.service"
import { type Clock, InjectClock } from "../../common/clock/clock"
import { ConflictProblem, NotFoundProblem, ValidationProblem } from "../../common/problems/problem.exception"
import { PublicUrls } from "../../common/urls"
import { MailService } from "../../mail/mail.service"
import type { OrgDeletionEvent } from "../../mail/templates/org-deletion"
import { MembershipRepository } from "../../memberships/repositories/membership.repository"
import { runAsTenant } from "../../platform/run-as-tenant"
import { PrismaService } from "../../prisma/prisma.service"
import { OrganizationLookupService } from "../../tenancy/organization-lookup.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { OrganizationLifecycleRepository } from "../repositories/organization-lifecycle.repository"

/**
 * Deleting a workspace, and changing one's mind (ADR-0043). An owner asks
 * from inside the workspace; from then on its subdomain 404s, so cancelling
 * happens from the picker on `app.`, where only `pg_id` reaches — which is why
 * this lives where `runAsTenant` may be used: the owner check reads the
 * membership inside the very tenant it is about.
 */
@Injectable()
export class OrgDeletionService {
  private readonly logger = new Logger(OrgDeletionService.name)

  constructor(
    private readonly lifecycle: OrganizationLifecycleRepository,
    private readonly memberships: MembershipRepository,
    private readonly epochs: RevocationEpochService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly stepUp: StepUpService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
    private readonly lookup: OrganizationLookupService,
    private readonly mail: MailService,
    private readonly urls: PublicUrls,
    private readonly prisma: PrismaService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  /** An owner, typing the slug. Everyone is out at once; the purge waits thirty days. */
  async request(confirmSlug: string): Promise<void> {
    const actor = this.actors.requireMember()
    this.permissions.assert(actor, "org:delete")
    // Irreversible after thirty days, and everyone is out at once: a fresh proof first (ADR-0029).
    this.stepUp.assert(actor)
    const orgId = this.tenant.requireOrgId()
    const now = this.clock.now()
    const org = await this.prisma.transaction(async () => {
      const found = await this.lifecycle.find(orgId)
      if (found === null) throw new NotFoundProblem()
      if (confirmSlug !== found.slug) {
        throw new ValidationProblem([{ path: "confirmSlug", message: "does not match this workspace's address", code: "slug_mismatch" }])
      }
      if (!(await this.lifecycle.requestDeletion(orgId, now))) throw new ConflictProblem("This workspace is not active")
      await this.audit.record(orgId, [
        {
          action: "ORG_DELETION_REQUESTED",
          entityType: "Organization",
          entityId: orgId,
          diff: { purgeAt: purgeDateFor(now).toISOString() },
        },
      ])
      return found
    })
    await this.lookup.invalidate({ id: orgId, slug: org.slug })
    // Every member's sessions end now, the requester's included (TENANCY.md §6).
    for (const membershipId of await this.prisma.transaction(() => this.lifecycle.membershipIds(orgId)))
      await this.epochs.bump(membershipId)
    // And every API token, which has no membership epoch to bump.
    await this.epochs.bump(orgEpochKey(orgId))
    const name = (await this.memberships.findById(orgId, actor.membershipId))?.displayName ?? "An owner"
    await this.tell(orgId, org.name, "requested", name, now)
  }

  /**
   * From the picker: the caller must be an active owner of that workspace,
   * which is read inside it. Everyone who was there before comes back; their
   * old sessions do not.
   */
  async cancelAsOwner(userId: string, orgId: string): Promise<void> {
    const org = await this.lifecycle.find(orgId)
    // Not a member, not an owner, or not pending: the same 404 — the picker shows only what it may.
    if (org === null || org.status !== "PENDING_DELETION" || org.deletionRequestedAt === null) throw new NotFoundProblem()
    const requestedAt = org.deletionRequestedAt
    await runAsTenant(orgId, { actor: `user:${userId}`, reason: "cancel workspace deletion" }, async () => {
      const owner = await this.prisma.transaction(async () => {
        const membership = await this.memberships.findByUser(orgId, userId)
        if (membership === null || membership.role !== "OWNER" || membership.status !== "ACTIVE") throw new NotFoundProblem()
        // Only an owner learns the window has closed; anyone else got the same 404 above.
        // From the purge date on, the purge owns it; never restore a workspace it may be emptying.
        if (this.clock.now().getTime() >= purgeDateFor(requestedAt).getTime())
          throw new ConflictProblem("This workspace's deletion window has closed")
        if (!(await this.lifecycle.cancelDeletion(orgId))) throw new ConflictProblem("This workspace is no longer pending deletion")
        await this.audit.record(orgId, [{ action: "ORG_DELETION_CANCELLED", entityType: "Organization", entityId: orgId }], {
          kind: "member",
          membershipId: membership.id,
        })
        return membership
      })
      await this.lookup.invalidate({ id: orgId, slug: org.slug })
      await this.epochs.clear(orgEpochKey(orgId))
      await this.tell(orgId, org.name, "cancelled", owner.displayName, requestedAt)
    })
  }

  /** After commit, inside the tenant; a mail that cannot be queued is logged, never fatal. */
  private async tell(orgId: string, orgName: string, event: OrgDeletionEvent, actorName: string, requestedAt: Date): Promise<void> {
    try {
      const to = await this.prisma.transaction(() => this.lifecycle.stewardAddresses(orgId))
      await this.mail.enqueueAll(
        to.map((address, i) => ({
          entityId: `${orgId}.deletion.${event}.${String(requestedAt.getTime())}.${String(i)}`,
          job: {
            kind: "org-deletion" as const,
            to: address,
            orgId,
            fromName: orgName,
            params: {
              orgName,
              event,
              actorName,
              purgeOn: `on ${purgeDateFor(requestedAt).toUTCString()}`,
              workspacesUrl: this.urls.app("/workspaces"),
            },
          },
        })),
      )
    } catch (error) {
      this.logger.error({ msg: "deletion mail not queued", orgId, event, error: String(error) })
    }
  }
}
