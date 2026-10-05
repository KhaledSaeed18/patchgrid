import { type ExecutionContext, Injectable } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from "@nestjs/throttler"

import type { Response } from "express"

import { RateLimitedProblem } from "../common/problems/problem.exception"
import { InjectConfig, type AppConfig } from "../config/app-config"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { AFTER_RESOLUTION, BEFORE_RESOLUTION } from "./throttlers"

/**
 * One throttler guard runs at one point in the pipeline, and the limits that
 * need the tenant cannot run before it is known. So: two guards, each taking
 * its share of the named throttlers, registered where they belong — this one
 * first of all (step 3), `OrgThrottlerGuard` right after resolution (step 6).
 *
 * The base class sets `Retry-After-<name>` before it asks us to throw; the
 * header clients actually honour is the plain `Retry-After`, so that is set
 * too, and what is thrown is a Problem (ADR-0012), not the library's exception.
 */
function refuse(context: ExecutionContext, detail: ThrottlerLimitDetail): never {
  context.switchToHttp().getResponse<Response>().setHeader("Retry-After", String(detail.timeToBlockExpire))
  throw new RateLimitedProblem(detail.timeToBlockExpire)
}
@Injectable()
export class IpThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super(options, storage, reflector)
  }

  override async onModuleInit(): Promise<void> {
    await super.onModuleInit()
    this.throttlers = this.throttlers.filter((t) => BEFORE_RESOLUTION.has(t.name ?? ""))
  }

  protected override async shouldSkip(): Promise<boolean> {
    return !this.config.THROTTLE_ENABLED
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    refuse(context, detail)
  }
}

@Injectable()
export class OrgThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    @InjectConfig() private readonly config: AppConfig,
    private readonly tenantContext: TenantContextService,
  ) {
    super(options, storage, reflector)
  }

  override async onModuleInit(): Promise<void> {
    await super.onModuleInit()
    this.throttlers = this.throttlers.filter((t) => AFTER_RESOLUTION.has(t.name ?? ""))
  }

  /** Nothing to count against on a route that resolved no tenant. */
  protected override async shouldSkip(): Promise<boolean> {
    return !this.config.THROTTLE_ENABLED || this.tenantContext.organization() === undefined
  }

  protected override async getTracker(): Promise<string> {
    return this.tenantContext.organization()?.id ?? "none"
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    refuse(context, detail)
  }
}
