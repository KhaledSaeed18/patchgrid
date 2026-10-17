/**
 * When to try again (ADR-0050). Attempt `n` (1-based) waits `RETRY_DELAYS_MS[n - 1]`
 * after the previous one; the seventh failure is the last.
 */
export const RETRY_DELAYS_MS = [0, 5_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 5 * 3_600_000, 10 * 3_600_000] as const
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length

/** ±20%, so a receiver that comes back is not met by every retry at once. */
export const JITTER = 0.2

/**
 * The delay before the attempt after `attemptsMade`, or `null` when there is
 * none left. `random` is in [0, 1); injected, so tests pin it.
 */
export function nextDelayMs(attemptsMade: number, random: number): number | null {
  if (attemptsMade >= MAX_ATTEMPTS) return null
  const base = RETRY_DELAYS_MS[attemptsMade] ?? 0
  return Math.round(base * (1 - JITTER + 2 * JITTER * random))
}

/** Consecutive failures that open an endpoint's circuit. */
export const CIRCUIT_THRESHOLD = 5
export const CIRCUIT_MIN_OPEN_MS = 60_000
export const CIRCUIT_MAX_OPEN_MS = 3_600_000
/** Failing without a success for this long disables the endpoint. */
export const DISABLE_AFTER_MS = 5 * 24 * 3_600_000

export type CircuitState = { consecutiveFailures: number; circuitOpenUntil: Date | null; failingSince: Date | null }
export type CircuitVerdict = CircuitState & { disable: boolean }

/** After a success: closed, nothing remembered. */
export function afterSuccess(): CircuitState {
  return { consecutiveFailures: 0, circuitOpenUntil: null, failingSince: null }
}

/**
 * After a failure: one more counted; at the threshold the circuit opens for a
 * minute, and each failed probe after that doubles it, to an hour. Five days
 * of failure without a success disables the endpoint.
 */
export function afterFailure(state: CircuitState, now: Date): CircuitVerdict {
  const consecutiveFailures = state.consecutiveFailures + 1
  const failingSince = state.failingSince ?? now
  const over = consecutiveFailures - CIRCUIT_THRESHOLD
  const circuitOpenUntil =
    over < 0 ? null : new Date(now.getTime() + Math.min(CIRCUIT_MAX_OPEN_MS, CIRCUIT_MIN_OPEN_MS * 2 ** Math.min(over, 16)))
  return { consecutiveFailures, circuitOpenUntil, failingSince, disable: now.getTime() - failingSince.getTime() >= DISABLE_AFTER_MS }
}

/** Whether an attempt must wait for the circuit; `null` when it may go now. */
export function waitForCircuit(state: Pick<CircuitState, "circuitOpenUntil">, now: Date): Date | null {
  return state.circuitOpenUntil !== null && state.circuitOpenUntil > now ? state.circuitOpenUntil : null
}
