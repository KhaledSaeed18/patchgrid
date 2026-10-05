import { Injectable } from "@nestjs/common"
import type { Role } from "@patchgrid/contracts"
import { ClsService } from "nestjs-cls"

import { NotAuthenticatedProblem } from "../common/problems/problem.exception"
import type { RequestContextStore } from "../tenancy/request-context"

/**
 * Who is making the request, once pipeline step 7 has verified the credential
 * (RBAC.md §11). `member` and the later `service` and `platform` kinds are what
 * `PermissionService` reasons about. `identity` is a `pg_id` holder on a
 * tenant-less route — the org picker — and never reaches authorization: it
 * can list workspaces and mint a session, nothing else.
 */
export type Actor =
  | {
      kind: "member"
      userId: string
      orgId: string
      membershipId: string
      role: Role
      teamIds: string[]
      leadOfTeamIds: string[]
    }
  | { kind: "identity"; userId: string }

export type MemberActor = Extract<Actor, { kind: "member" }>
export type IdentityActor = Extract<Actor, { kind: "identity" }>

declare module "../tenancy/request-context" {
  interface RequestContextStore {
    /** Set only by `AuthGuard`, after the credential is verified. */
    actor?: Actor
  }
}

/** The read side. No setter, for the same reason `TenantContextService` has none. */
@Injectable()
export class ActorService {
  constructor(private readonly cls: ClsService<RequestContextStore>) {}

  current(): Actor | undefined {
    return this.cls.isActive() ? this.cls.get("actor") : undefined
  }

  requireMember(): MemberActor {
    const actor = this.current()
    if (actor?.kind !== "member") throw new NotAuthenticatedProblem()
    return actor
  }

  requireIdentity(): IdentityActor {
    const actor = this.current()
    if (actor?.kind !== "identity") throw new NotAuthenticatedProblem()
    return actor
  }
}
