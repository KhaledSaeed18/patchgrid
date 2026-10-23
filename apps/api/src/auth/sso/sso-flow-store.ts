import { Injectable, Logger } from "@nestjs/common"
import { idSchema, ssoIntentSchema, ssoReturnPathSchema } from "@patchgrid/contracts"
import { z } from "zod"

import { ServiceUnavailableProblem } from "../../common/problems/problem.exception"
import { RedisService } from "../../redis/redis.service"

/** How long a person has at the identity provider before the round trip is void. */
export const SSO_FLOW_TTL_SECONDS = 10 * 60

const flowSchema = z.object({
  orgId: idSchema,
  connectionId: idSchema,
  codeVerifier: z.string().min(43).max(128),
  nonce: z.string().min(16).max(128),
  intent: ssoIntentSchema,
  next: ssoReturnPathSchema.nullable(),
  /** Unix seconds: step-up's `auth_time` must not be older. */
  startedAt: z.int(),
})
export type SsoFlow = z.infer<typeof flowSchema>

/**
 * One SSO round trip, kept under its `state` for ten minutes and spent with
 * `GETDEL` (ADR-0054): a callback is accepted at most once, and only for the
 * flow that started it. Redis down is a `503`, as the other ceremonies are.
 */
@Injectable()
export class SsoFlowStore {
  private readonly logger = new Logger(SsoFlowStore.name)

  constructor(private readonly redis: RedisService) {}

  async put(state: string, flow: SsoFlow): Promise<void> {
    try {
      await this.redis.client.set(key(state), JSON.stringify(flow), "EX", SSO_FLOW_TTL_SECONDS)
    } catch (error) {
      this.logger.error({ msg: "sso flow store unavailable", error: String(error) })
      throw new ServiceUnavailableProblem("Single sign-on cannot start right now; retry shortly")
    }
  }

  /** The flow, once; `null` for an unknown, spent or expired state. */
  async take(state: string): Promise<SsoFlow | null> {
    let raw: string | null
    try {
      raw = await this.redis.client.getdel(key(state))
    } catch (error) {
      this.logger.error({ msg: "sso flow store unavailable", error: String(error) })
      throw new ServiceUnavailableProblem("Single sign-on cannot finish right now; retry shortly")
    }
    if (raw === null) return null
    try {
      const parsed = flowSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
}

const key = (state: string): string => `sso:flow:${state}`
