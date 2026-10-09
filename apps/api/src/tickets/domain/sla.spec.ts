import { describe, expect, it } from "vitest"

import {
  clockView,
  deadlines,
  onCreate,
  onPause,
  onPolicyChange,
  onReopen,
  onResolve,
  onResponded,
  onResume,
  scanSignals,
  type SlaPolicyTargets,
  type SlaState,
} from "./sla"

const T0 = new Date("2026-10-09T08:00:00Z")
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
const HIGH: SlaPolicyTargets = { responseTargetMinutes: 30, resolutionTargetMinutes: 480, responseWarningMinutes: 10, resolutionWarningMinutes: 60 }
const CRITICAL: SlaPolicyTargets = { responseTargetMinutes: 15, resolutionTargetMinutes: 240, responseWarningMinutes: 5, resolutionWarningMinutes: 45 }

function created(policy: SlaPolicyTargets | null = HIGH): SlaState {
  return {
    ...onCreate(T0, policy),
    respondedAt: null,
    resolvedAt: null,
    closedAt: null,
    pausedAt: null,
    responseBreached: false,
    resolutionBreached: false,
    responseWarningSentAt: null,
    resolutionWarningSentAt: null,
    reopenCount: 0,
  }
}
const apply = (state: SlaState, patch: Partial<SlaState>): SlaState => ({ ...state, ...patch })

describe("the SLA clock (DOMAIN.md §4.2)", () => {
  it("starts both clocks at creation", () => {
    const s = created()
    expect(s.respondBy).toEqual(at(30))
    expect(s.resolveBy).toEqual(at(480))
  })

  it("has no clock without a policy — problems and changes", () => {
    expect(deadlines(created(null), null)).toEqual({ respondBy: null, resolveBy: null })
  })

  it("stops the response clock on the first response only", () => {
    const s = apply(created(), onResponded(created(), at(10)))
    expect(s.respondedAt).toEqual(at(10))
    expect(onResponded(s, at(20))).toEqual({})
  })

  it("pushes the resolution deadline out by exactly the paused whole minutes", () => {
    let s = apply(created(), onPause(created(), at(60)))
    expect(clockView(s, at(10_000)).resolution).toMatchObject({ paused: true, breached: false })
    s = apply(s, onResume(s, at(60 + 90.9), HIGH))
    expect(s.pausedMinutes).toBe(90)
    expect(s.pausedAt).toBeNull()
    expect(s.resolveBy).toEqual(at(480 + 90))
    // A second pause adds to the first.
    s = apply(s, onPause(s, at(200)))
    s = apply(s, onResume(s, at(230), HIGH))
    expect(s.pausedMinutes).toBe(120)
    expect(s.resolveBy).toEqual(at(600))
  })

  it("resolving answers an unanswered ticket and stops the resolution clock", () => {
    const s = apply(created(), onResolve(created(), at(100)))
    expect(s).toMatchObject({ resolvedAt: at(100), respondedAt: at(100) })
    const answered = apply(created(), { respondedAt: at(5) })
    expect(onResolve(answered, at(100)).respondedAt).toBeUndefined()
  })

  it("reopen restarts only the resolution clock, from now, clean", () => {
    let s = apply(created(), { respondedAt: at(5), pausedMinutes: 40, resolutionBreached: true, resolutionWarningSentAt: at(400) })
    s = apply(s, onResolve(s, at(500)))
    s = apply(s, onReopen(s, at(1000), HIGH))
    expect(s).toMatchObject({
      responseClockStartedAt: T0,
      respondedAt: at(5),
      resolutionClockStartedAt: at(1000),
      pausedMinutes: 0,
      resolutionBreached: false,
      resolutionWarningSentAt: null,
      resolvedAt: null,
      reopenCount: 1,
      resolveBy: at(1000 + 480),
    })
  })

  it("a priority change recomputes from the stored origins — never moving a reopen's origin back", () => {
    let s = apply(created(), onReopen(created(), at(1000), HIGH))
    s = apply(s, onPolicyChange(s, CRITICAL))
    expect(s.resolveBy).toEqual(at(1000 + 240))
    expect(s.respondBy).toEqual(at(15))
  })

  it("keeps a met response deadline as history when the priority changes", () => {
    const s = apply(created(), { respondedAt: at(10) })
    expect(onPolicyChange(s, CRITICAL)).toEqual({ resolveBy: at(240) })
  })

  it("reports a clock as breached once past due, and a stopped clock by when it stopped", () => {
    const s = created()
    expect(clockView(s, at(29)).response.breached).toBe(false)
    expect(clockView(s, at(31)).response.breached).toBe(true)
    const late = apply(s, { respondedAt: at(45) })
    expect(clockView(late, at(10_000)).response).toMatchObject({ breached: true, stoppedAt: at(45) })
    const early = apply(s, { respondedAt: at(5) })
    expect(clockView(early, at(10_000)).response.breached).toBe(false)
  })
})

describe("the SLA scan (DOMAIN.md §4.3)", () => {
  it("warns inside the window, then breaches at the deadline — each once", () => {
    const fresh = created()
    expect(scanSignals(fresh, HIGH, at(19))).toEqual([])
    expect(scanSignals(fresh, HIGH, at(20))).toEqual([{ clock: "response", kind: "warning" }])
    const warned = apply(fresh, { responseWarningSentAt: at(20) })
    expect(scanSignals(warned, HIGH, at(25))).toEqual([])
    expect(scanSignals(warned, HIGH, at(30))).toEqual([{ clock: "response", kind: "breach" }])
    expect(scanSignals(apply(warned, { responseBreached: true }), HIGH, at(31))).toEqual([])
  })

  it("goes straight to the breach when the warning was missed", () => {
    expect(scanSignals(created(), HIGH, at(45))).toEqual([{ clock: "response", kind: "breach" }])
  })

  it("never warns when the window opens at or before the clock starts", () => {
    const tight = { ...HIGH, responseWarningMinutes: 30 }
    expect(scanSignals(created(tight), tight, at(1))).toEqual([])
    expect(scanSignals(created(tight), tight, at(30))).toEqual([{ clock: "response", kind: "breach" }])
  })

  it("stops the response clock at a response, and the resolution clock while paused or once resolved", () => {
    const answered = apply(created(), onResponded(created(), at(5)))
    expect(scanSignals(answered, HIGH, at(430))).toEqual([{ clock: "resolution", kind: "warning" }])
    const paused = apply(answered, onPause(answered, at(100)))
    expect(scanSignals(paused, HIGH, at(500))).toEqual([])
    const resolved = apply(answered, onResolve(answered, at(200)))
    expect(scanSignals(resolved, HIGH, at(10_000))).toEqual([])
  })

  it("measures a reopened ticket's warning from its new origin", () => {
    const answered = apply(created(), onResponded(created(), at(5)))
    const reopened = apply(answered, onReopen(answered, at(1000), HIGH))
    expect(scanSignals(reopened, HIGH, at(1000 + 419))).toEqual([])
    expect(scanSignals(reopened, HIGH, at(1000 + 420))).toEqual([{ clock: "resolution", kind: "warning" }])
  })
})
