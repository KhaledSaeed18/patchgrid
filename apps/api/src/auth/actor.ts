import { Injectable } from "@nestjs/common"
import type { Role, TokenScope } from "@patchgrid/contracts"
import { ClsService } from "nestjs-cls"

import { NotAuthenticatedProblem } from "../common/problems/problem.exception"
import type { RequestContextStore } from "../tenancy/request-context"

/**
 * Who is making the request, once pipeline step 7 has verified the credential
 * (RBAC.md §11). `member` and `service` — and the later `platform` kind — are
 * what `PermissionService` reasons about. `service` is an API token's actor; the
 * type exists so authorization is written for it now, and the M8 api-tokens item
 * is what first constructs one. `identity` is a `pg_id` holder on a
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
  | { kind: "service"; orgId: string; membershipId: string; role: Role; scopes: TokenScope[] }
  | { kind: "identity"; userId: string }
  /**
   * An operator inside a granted support session, on the tenant's own routes
   * (ADR-0041): role `ADMIN` for the matrix, narrowed to the support read set,
   * read-only at the guard. `membershipId` is the session id — never a
   * membership, so no "own", "assignee" or "watcher" relation can hold.
   */
  | { kind: "support"; orgId: string; sessionId: string; platformAdminId: string; userId: string; role: "ADMIN"; membershipId: string }
  /** An operator, from the platform credential only (ADR-0040). Holds no tenant permission. */
  | { kind: "platform"; platformAdminId: string; userId: string; sessionExpiresAt: number }

/**
 * When the credential behind a member actor was minted and when it lapses.
 * A long-lived response — the notification stream — lives no longer than the
 * token that opened it, and re-checks the revocation epoch against `issuedAt`.
 */
export type Credential = { issuedAt: number; expiresAt: number }

export type MemberActor = Extract<Actor, { kind: "member" }>
export type ServiceActor = Extract<Actor, { kind: "service" }>
export type IdentityActor = Extract<Actor, { kind: "identity" }>
export type PlatformActor = Extract<Actor, { kind: "platform" }>
export type SupportActor = Extract<Actor, { kind: "support" }>
/** Someone acting inside one organization — what authorization decides about. */
export type TenantActor = MemberActor | ServiceActor | SupportActor

declare module "../tenancy/request-context" {
  interface RequestContextStore {
    /** Set only by `AuthGuard`, after the credential is verified. */
    actor?: Actor
    /** The verified access token's lifetime, in unix seconds — set beside `actor` for a member. */
    credential?: Credential
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

  /** A member or a service account: anyone authorization can decide about. */
  requireTenantActor(): TenantActor {
    const actor = this.current()
    if (actor?.kind !== "member" && actor?.kind !== "service" && actor?.kind !== "support") throw new NotAuthenticatedProblem()
    return actor
  }

  /** The member's credential, when the actor came from an access token. */
  credential(): Credential | undefined {
    return this.cls.isActive() ? this.cls.get("credential") : undefined
  }

  /** An operator signed in with the platform credential; anyone else is a 401 on a platform route. */
  requirePlatform(): PlatformActor {
    const actor = this.current()
    if (actor?.kind !== "platform") throw new NotAuthenticatedProblem()
    return actor
  }

  requireIdentity(): IdentityActor {
    const actor = this.current()
    if (actor?.kind !== "identity") throw new NotAuthenticatedProblem()
    return actor
  }
}
