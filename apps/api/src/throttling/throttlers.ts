import type { ExecutionContext } from "@nestjs/common"
import { SkipThrottle, type ThrottlerOptions } from "@nestjs/throttler"
import type { Request } from "express"

import { emailHash8 } from "../common/privacy"

const MINUTE = 60_000

/** Every request from one address. Routes tighten it with `@Throttle`. */
export const IP_THROTTLER = "ip"
/** Every identity request naming one address, whoever sends it (ADR-0031). */
export const EMAIL_THROTTLER = "email"
/** Every request inside one organization, after resolution (pipeline step 6). */
export const ORG_THROTTLER = "org"

/**
 * The limits (ARCHITECTURE.md §Security posture): generous by default, tight on
 * authentication, signup and slug lookup — see the `@Throttle` on those
 * controllers. Numbers are per window, windows are a minute.
 */
export const THROTTLERS: ThrottlerOptions[] = [
  { name: IP_THROTTLER, limit: 300, ttl: MINUTE },
  {
    name: EMAIL_THROTTLER,
    limit: 5,
    ttl: MINUTE,
    // Only requests that name an address; the tracker is its hash, never the address.
    skipIf: (context: ExecutionContext) => emailIn(context) === undefined,
    getTracker: (_req, context) => emailHash8(emailIn(context) ?? ""),
  },
  { name: ORG_THROTTLER, limit: 600, ttl: MINUTE },
]

/**
 * `@SkipThrottle()` with no argument skips only a throttler named `default`,
 * which none of ours is. This skips every one of them.
 */
export const SkipAllThrottling = (): MethodDecorator & ClassDecorator =>
  SkipThrottle({ [IP_THROTTLER]: true, [EMAIL_THROTTLER]: true, [ORG_THROTTLER]: true })

/** Steps 3 and 6 are two guards in two places; each takes its share of the list. */
export const BEFORE_RESOLUTION: ReadonlySet<string> = new Set([IP_THROTTLER, EMAIL_THROTTLER])
export const AFTER_RESOLUTION: ReadonlySet<string> = new Set([ORG_THROTTLER])

function emailIn(context: ExecutionContext): string | undefined {
  const body: unknown = context.switchToHttp().getRequest<Request>().body
  if (typeof body !== "object" || body === null) return undefined
  const email = (body as { email?: unknown }).email
  return typeof email === "string" && email !== "" ? email : undefined
}
