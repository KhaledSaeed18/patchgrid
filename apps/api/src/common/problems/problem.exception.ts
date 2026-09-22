import {
  type ProblemError,
  type ProblemTypeSlug,
  problemStatus,
  problemTitle,
} from "@patchgrid/contracts"

/**
 * The only kind of error services throw.
 *
 * Services do not throw `HttpException`, because HTTP is the controller's
 * concern and a service that knows about status codes has stopped being a
 * service (`ARCHITECTURE.md` §Layered architecture). They throw a *problem*,
 * which the global filter renders as RFC 9457 (ADR-0012).
 */
export class ProblemException extends Error {
  constructor(
    readonly problemType: ProblemTypeSlug,
    readonly detail?: string,
    readonly errors?: readonly ProblemError[],
  ) {
    super(detail ?? problemTitle(problemType))
    this.name = new.target.name
  }

  get status(): number {
    return problemStatus(this.problemType)
  }
}

/**
 * Reads of a record the actor may not see return this, not `NotPermitted` —
 * `RBAC.md` §11: a read of an invisible record must be indistinguishable from a
 * read of an absent one, or the 403 itself discloses that the record exists.
 */
export class NotFoundProblem extends ProblemException {
  constructor(detail?: string) {
    super("not-found", detail)
  }
}

/** An action on a record the actor *can* see but may not perform. */
export class NotPermittedProblem extends ProblemException {
  constructor(detail?: string) {
    super("not-permitted", detail)
  }
}

export class NotAuthenticatedProblem extends ProblemException {
  constructor(detail?: string) {
    super("not-authenticated", detail)
  }
}

/** The credential names one organization and the request asserted another. */
export class TenantMismatchProblem extends ProblemException {
  constructor(detail?: string) {
    super("tenant-mismatch", detail)
  }
}

export class OrganizationSuspendedProblem extends ProblemException {
  constructor(detail?: string) {
    super("organization-suspended", detail)
  }
}

/** `402`, and only ever a plan limit — never a permission problem. */
export class PlanLimitProblem extends ProblemException {
  constructor(
    readonly metric: string,
    detail?: string,
  ) {
    super("plan-limit-reached", detail ?? `The organization has reached its ${metric} limit`)
  }
}

export class ConflictProblem extends ProblemException {
  constructor(detail?: string) {
    super("conflict", detail)
  }
}

/** Names both the current status and the attempted action — good errors for free. */
export class InvalidTransitionProblem extends ProblemException {
  constructor(from: string, action: string) {
    super("invalid-transition", `Cannot '${action}' a ticket in status '${from}'`)
  }
}

/** Optimistic concurrency: somebody else wrote first. */
export class StaleWriteProblem extends ProblemException {
  constructor(detail = "The record changed since you loaded it") {
    super("stale-write", detail)
  }
}

export class ValidationProblem extends ProblemException {
  constructor(errors: readonly ProblemError[], detail = "The request failed validation") {
    super("validation-failed", detail, errors)
  }
}
