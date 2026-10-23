import { Injectable, Logger } from "@nestjs/common"
import {
  limitFor,
  limitReachedAt,
  type MembershipKind,
  type MembershipStatus,
  type Role,
  type Usage,
  type UsageMetric,
  usageMetricSchema,
  usagePeriod,
} from "@patchgrid/contracts"

import { type Clock, InjectClock } from "../common/clock/clock"
import { Outbox } from "../events/outbox"
import { NotFoundProblem, PlanLimitProblem } from "../common/problems/problem.exception"
import { recordQuotaRejection } from "../telemetry/metrics"
import { UsageCounterRepository } from "./repositories/usage-counter.repository"

/** A seat is an active human at AGENT or above (ADR-0033, TENANCY.md §8). */
export function holdsSeat(member: { role: Role; status: MembershipStatus; kind: MembershipKind }): boolean {
  return member.kind === "HUMAN" && member.status === "ACTIVE" && member.role !== "REQUESTER"
}

/**
 * Plan limits (TENANCY.md §8). `consume` and `release` run INSIDE the
 * transaction that creates or ends the counted thing: a `402` rolls that
 * transaction back with the row that did not fit, and a release commits with
 * the change that freed the unit. Postgres is the source of truth; nothing
 * here reads a cache before deciding.
 *
 * The consume that takes usage across the line where a limit counts as
 * reached writes a `plan-limit-reached` event in the same transaction, so the
 * admins and owners hear of it once per crossing (DOMAIN.md §8). A refused
 * consume cannot: its transaction rolls back, event and all.
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name)

  constructor(
    private readonly counters: UsageCounterRepository,
    private readonly outbox: Outbox,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async consume(orgId: string, metric: UsageMetric, amount = 1): Promise<void> {
    const plan = await this.counters.planOf(orgId)
    if (plan === null) throw new NotFoundProblem()
    const period = usagePeriod(metric, this.clock.now())
    const limit = limitFor(plan, metric)
    await this.counters.ensure(orgId, period, metric)
    if (!(await this.counters.increment(orgId, period, metric, amount, limit))) {
      recordQuotaRejection(orgId, metric)
      throw new PlanLimitProblem(metric, limitMessage(metric, plan))
    }
    if (limit === null) return
    // Read under the row lock the increment took: no other consume moved it in between.
    const after = await this.counters.read(orgId, period, metric)
    const line = BigInt(limitReachedAt(metric, limit))
    if (after - BigInt(amount) < line && after >= line) {
      await this.outbox.append(orgId, [{ type: PLAN_LIMIT_REACHED, payload: { kind: PLAN_LIMIT_REACHED, metric, period, plan, limit, message: limitMessage(metric, plan) } }])
    }
  }

  async release(orgId: string, metric: UsageMetric, amount = 1): Promise<void> {
    const period = usagePeriod(metric, this.clock.now())
    if ((await this.counters.decrement(orgId, period, metric, amount)) === "floored") {
      // Drift is a bug, not a state; the nightly reconcile recomputes it.
      this.logger.error({ msg: "usage counter would have gone negative", orgId, metric, period })
    }
  }

  /** A hint for an early, friendly 402 — never the enforcement, which is `consume`. */
  async hasRoom(orgId: string, metric: UsageMetric, amount = 1): Promise<boolean> {
    const plan = await this.counters.planOf(orgId)
    if (plan === null) return false
    const limit = limitFor(plan, metric)
    if (limit === null) return true
    const used = await this.counters.read(orgId, usagePeriod(metric, this.clock.now()), metric)
    return used + BigInt(amount) <= BigInt(limit)
  }

  async usage(orgId: string): Promise<Usage> {
    const plan = await this.counters.planOf(orgId)
    if (plan === null) throw new NotFoundProblem()
    const now = this.clock.now()
    const metrics = usageMetricSchema.options
    const rows = await this.counters.list(orgId, [...new Set(metrics.map((m) => usagePeriod(m, now)))])
    return {
      plan,
      metrics: metrics.map((metric) => {
        const period = usagePeriod(metric, now)
        const row = rows.find((r) => r.metric === metric && r.period === period)
        return { metric, period, used: Number(row?.value ?? 0n), limit: limitFor(plan, metric) }
      }),
    }
  }
}

/** The outbox event a limit reached is (DOMAIN.md §8); the `notify` consumer tells the admins and owners. */
export const PLAN_LIMIT_REACHED = "plan-limit-reached"

function limitMessage(metric: UsageMetric, plan: string): string {
  switch (metric) {
    case "AGENT_SEATS":
      return `The ${plan} plan's agent seats are all in use`
    case "TICKETS_CREATED":
      return `The ${plan} plan's tickets for this month are used up`
    case "STORAGE_BYTES":
      return `The ${plan} plan's attachment storage is full`
    case "AUTOMATION_RULES":
      return `The ${plan} plan's automation rules are all in use`
    case "KB_ARTICLES":
      return `The ${plan} plan's knowledge articles are all in use`
    case "API_TOKENS":
      return `The ${plan} plan's API tokens are all in use`
  }
}
