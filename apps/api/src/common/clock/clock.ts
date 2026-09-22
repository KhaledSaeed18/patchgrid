import { Inject } from "@nestjs/common"

/**
 * Time, injected.
 *
 * SLA maths is a pure function of `(origins, policy, pausedMinutes, now)`
 * (`DOMAIN.md` §4.2), which is only true if `now` is an input. Reading the clock
 * directly inside a service is what forces tests to sleep, and a test suite that
 * sleeps is a test suite nobody runs.
 */
export const CLOCK = Symbol("CLOCK")

export const InjectClock = (): ParameterDecorator => Inject(CLOCK)

export interface Clock {
  now(): Date
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
}

/** For tests: a clock that only moves when told to. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current
  }

  set(at: Date): void {
    this.current = at
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds)
  }
}
