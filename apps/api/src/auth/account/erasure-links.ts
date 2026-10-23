import { Injectable } from "@nestjs/common"

import { RedisService } from "../../redis/redis.service"
import { hash } from "../sessions/session.service"

/** How long an erasure link works. */
export const ERASURE_LINK_MINUTES = 30

/**
 * Erasure links (ADR-0044 erratum): the secret's hash names the account for
 * half an hour, and is spent with `GETDEL`, so a link works exactly once.
 * Redis, like the SSO flow and passkey challenges: a short-lived proof, not
 * a record.
 */
@Injectable()
export class ErasureLinks {
  constructor(private readonly redis: RedisService) {}

  async put(secret: string, userId: string): Promise<void> {
    await this.redis.client.set(key(secret), userId, "EX", ERASURE_LINK_MINUTES * 60)
  }

  /** The account the link names, once; `null` for a link spent, lapsed or never issued. */
  async take(secret: string): Promise<string | null> {
    return this.redis.client.getdel(key(secret))
  }
}

const key = (secret: string): string => `erase:${hash(secret)}`
