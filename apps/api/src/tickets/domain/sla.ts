/**
 * The SLA clocks (DOMAIN.md §4.2) — a pure function of the stored origins,
 * the policy, the paused minutes and `now`. Both deadlines are one formula:
 *
 *   respondBy = responseClockStartedAt   + responseTargetMinutes
 *   resolveBy = resolutionClockStartedAt + resolutionTargetMinutes + pausedMinutes
 *
 * Each event in §4.2's table is one function returning the fields it changes,
 * so the service applies exactly that patch and the audit diff names it.
 */

export type SlaPolicyTargets = {
  responseTargetMinutes: number
  resolutionTargetMinutes: number
  responseWarningMinutes: number
  resolutionWarningMinutes: number
}

export type SlaState = {
  responseClockStartedAt: Date
  resolutionClockStartedAt: Date
  respondedAt: Date | null
  resolvedAt: Date | null
  closedAt: Date | null
  pausedAt: Date | null
  pausedMinutes: number
  respondBy: Date | null
  resolveBy: Date | null
  responseBreached: boolean
  resolutionBreached: boolean
  responseWarningSentAt: Date | null
  resolutionWarningSentAt: Date | null
  reopenCount: number
}

const MINUTE = 60_000
const plus = (at: Date, minutes: number) => new Date(at.getTime() + minutes * MINUTE)

/** The two deadlines from the stored origins. No policy (Problems, Changes) means no clock. */
export function deadlines(
  state: Pick<SlaState, "responseClockStartedAt" | "resolutionClockStartedAt" | "pausedMinutes">,
  policy: SlaPolicyTargets | null,
): { respondBy: Date | null; resolveBy: Date | null } {
  if (policy === null) return { respondBy: null, resolveBy: null }
  return {
    respondBy: plus(state.responseClockStartedAt, policy.responseTargetMinutes),
    resolveBy: plus(state.resolutionClockStartedAt, policy.resolutionTargetMinutes + state.pausedMinutes),
  }
}

/** Ticket created: both origins are its creation. */
export function onCreate(now: Date, policy: SlaPolicyTargets | null): Pick<
  SlaState,
  "responseClockStartedAt" | "resolutionClockStartedAt" | "respondBy" | "resolveBy" | "pausedMinutes"
> {
  const origins = { responseClockStartedAt: now, resolutionClockStartedAt: now, pausedMinutes: 0 }
  return { ...origins, ...deadlines(origins, policy) }
}

/**
 * The first public reply by an agent, or a resolve, whichever comes first,
 * stops the response clock; a later one changes nothing.
 */
export function onResponded(state: SlaState, now: Date): Partial<SlaState> {
  return state.respondedAt === null ? { respondedAt: now } : {}
}

/** → PENDING: the resolution clock pauses. */
export function onPause(state: SlaState, now: Date): Partial<SlaState> {
  return state.pausedAt === null ? { pausedAt: now } : {}
}

/**
 * PENDING → IN_PROGRESS: the paused span joins `pausedMinutes` and the
 * resolution deadline moves out by it. Whole minutes, rounded down — the
 * stricter reading, never in the ticket's favour.
 */
export function onResume(state: SlaState, now: Date, policy: SlaPolicyTargets | null): Partial<SlaState> {
  if (state.pausedAt === null) return {}
  const pausedMinutes = state.pausedMinutes + Math.floor((now.getTime() - state.pausedAt.getTime()) / MINUTE)
  return { pausedAt: null, pausedMinutes, resolveBy: deadlines({ ...state, pausedMinutes }, policy).resolveBy }
}

/** → RESOLVED: the resolution clock stops; an unanswered ticket counts as answered. */
export function onResolve(state: SlaState, now: Date): Partial<SlaState> {
  return { resolvedAt: now, ...onResponded(state, now) }
}

/** → CLOSED. */
export function onClose(now: Date): Partial<SlaState> {
  return { closedAt: now }
}

/**
 * reopen: the response clock is not restarted; the resolution clock starts
 * fresh from now, unpaused, unbreached, unwarned.
 */
export function onReopen(state: SlaState, now: Date, policy: SlaPolicyTargets | null): Partial<SlaState> {
  const fresh = { resolutionClockStartedAt: now, pausedMinutes: 0 }
  return {
    ...fresh,
    resolvedAt: null,
    closedAt: null,
    pausedAt: null,
    resolutionBreached: false,
    resolutionWarningSentAt: null,
    reopenCount: state.reopenCount + 1,
    resolveBy: deadlines({ ...state, ...fresh }, policy).resolveBy,
  }
}

/**
 * Impact or urgency changed, so the policy may have: both deadlines are
 * recomputed from the STORED origins — a reopen's later origin is never
 * silently moved back. A response already given keeps its deadline as history.
 */
export function onPolicyChange(state: SlaState, policy: SlaPolicyTargets | null): Partial<SlaState> {
  const next = deadlines(state, policy)
  return {
    ...(state.respondedAt === null ? { respondBy: next.respondBy } : {}),
    ...(state.resolvedAt === null ? { resolveBy: next.resolveBy } : {}),
  }
}

export type ClockView = { due: Date | null; stoppedAt: Date | null; breached: boolean; paused: boolean }

/**
 * Where each clock stands now — what the console's countdown and breach badge
 * read. A stopped clock reports whether it stopped late; a running one whether
 * it is already past due (the scan sets the flag; this does not wait for it).
 */
export function clockView(state: SlaState, now: Date): { response: ClockView; resolution: ClockView } {
  const late = (due: Date | null, at: Date) => due !== null && at.getTime() > due.getTime()
  return {
    response: {
      due: state.respondBy,
      stoppedAt: state.respondedAt,
      breached: state.responseBreached || late(state.respondBy, state.respondedAt ?? now),
      paused: false,
    },
    resolution: {
      due: state.resolveBy,
      stoppedAt: state.resolvedAt,
      // While paused, the deadline keeps moving out; it cannot be passed.
      breached:
        state.resolutionBreached || (state.pausedAt === null && late(state.resolveBy, state.resolvedAt ?? now)),
      paused: state.pausedAt !== null,
    },
  }
}

export type SlaClock = "response" | "resolution"
export type SlaSignal = { clock: SlaClock; kind: "warning" | "breach" }

/**
 * What the scan should flag on one ticket now (DOMAIN.md §4.3), from what it
 * has already flagged — so a scan that runs twice signals nothing twice.
 *
 * - A running clock past its deadline is a **breach**, once.
 * - One within its warning window is a **warning**, once — unless the window
 *   opened at or before the clock's origin: a 15-minute target with a
 *   20-minute warning would otherwise warn at the instant of creation.
 *   (§4.3 says `createdAt`; the clock's origin is the same thing for the
 *   response clock and the correct thing after a reopen moves the resolution
 *   clock's.)
 * - A breach found before its warning skips the warning: nobody needs to be
 *   told a target is close once it has passed.
 * - The response clock runs until a response or a resolution; the resolution
 *   clock until a resolution, and not while paused.
 */
export function scanSignals(
  state: Pick<
    SlaState,
    | "responseClockStartedAt"
    | "resolutionClockStartedAt"
    | "respondedAt"
    | "resolvedAt"
    | "pausedAt"
    | "respondBy"
    | "resolveBy"
    | "responseBreached"
    | "resolutionBreached"
    | "responseWarningSentAt"
    | "resolutionWarningSentAt"
  >,
  warnings: Pick<SlaPolicyTargets, "responseWarningMinutes" | "resolutionWarningMinutes">,
  now: Date,
): SlaSignal[] {
  const signals: SlaSignal[] = []
  const check = (
    clock: SlaClock,
    running: boolean,
    origin: Date,
    due: Date | null,
    warningMinutes: number,
    breached: boolean,
    warned: boolean,
  ) => {
    if (!running || due === null || breached) return
    if (now.getTime() >= due.getTime()) {
      signals.push({ clock, kind: "breach" })
      return
    }
    const warnAt = plus(due, -warningMinutes)
    if (!warned && warnAt.getTime() > origin.getTime() && now.getTime() >= warnAt.getTime()) {
      signals.push({ clock, kind: "warning" })
    }
  }
  const resolved = state.resolvedAt !== null
  check(
    "response",
    state.respondedAt === null && !resolved,
    state.responseClockStartedAt,
    state.respondBy,
    warnings.responseWarningMinutes,
    state.responseBreached,
    state.responseWarningSentAt !== null,
  )
  check(
    "resolution",
    !resolved && state.pausedAt === null,
    state.resolutionClockStartedAt,
    state.resolveBy,
    warnings.resolutionWarningMinutes,
    state.resolutionBreached,
    state.resolutionWarningSentAt !== null,
  )
  return signals
}
