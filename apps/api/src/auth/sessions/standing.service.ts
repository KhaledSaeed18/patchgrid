import { Injectable } from "@nestjs/common"

import { MembershipRepository } from "../../memberships/repositories/membership.repository"
import { runAsTenant } from "../../platform/run-as-tenant"
import type { MemberActor } from "../actor"
import { RevocationEpochService } from "../revocation/revocation-epoch.service"

/**
 * Whether a credential verified some time ago still stands, and as whom
 * (ADR-0036). A request is authenticated once, at its start; a long-lived
 * response — the notification stream — asks again as it runs, outside any
 * request, so the membership is read inside its tenant here, in the module
 * allowed to cross into one.
 *
 * `null` when the session was revoked or the membership is no longer active.
 * The member as they are NOW otherwise: a role or team change between the
 * epoch bump and its commit is caught by the read even when the bump is not.
 * Redis unreachable: the epoch is unknown and the read decides alone — reads
 * stay open (ADR-0024).
 */
@Injectable()
export class StandingService {
  constructor(
    private readonly epochs: RevocationEpochService,
    private readonly memberships: MembershipRepository,
  ) {}

  async check(actor: MemberActor, issuedAt: number): Promise<MemberActor | null> {
    if ((await this.epochs.isRevoked(actor.membershipId, issuedAt)) === true) return null
    const membership = await runAsTenant(actor.orgId, { actor: `member:${actor.membershipId}`, reason: "re-check a long-lived session" }, () =>
      this.memberships.findById(actor.orgId, actor.membershipId),
    )
    if (membership === null || membership.status !== "ACTIVE" || membership.userId !== actor.userId) return null
    return { ...actor, role: membership.role, teamIds: membership.teamIds, leadOfTeamIds: membership.leadOfTeamIds }
  }
}
