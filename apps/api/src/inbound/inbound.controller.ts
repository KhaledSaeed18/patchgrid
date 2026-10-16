import { Throttle } from "@nestjs/throttler"
import { Controller, HttpCode, Post, Req } from "@nestjs/common"
import type { Request } from "express"
import express from "express"

import { Public, SignedWebhook } from "../common/decorators/route-markers"
import { NotAuthenticatedProblem } from "../common/problems/problem.exception"
import { InboundReceiver } from "./inbound-receiver.service"

/** The webhook path, under the API's global prefix. */
export const INBOUND_WEBHOOK_PATH = "/api/v1/inbound/email"

/**
 * The raw bytes for the webhook route, before the JSON parser sees them: a
 * signature is over bytes, not over whatever a parser made of them. Mounted by
 * `main.ts` (and the specs that boot the app) ahead of Nest's own parser.
 */
export function inboundBodyParser() {
  return express.raw({ type: () => true, limit: "40mb" })
}

/**
 * `POST /inbound/email` (ADR-0039). `@Public` because its credential is the
 * webhook signature, which the receiver checks before anything else — not a
 * session, and not a tenant: the tenant is the recipient, resolved after.
 * `202` whatever became of the recipients, so the answer says nothing about
 * which workspaces exist.
 */
// Unauthenticated POSTs of up to 40 MB each cost an HMAC before refusal: fewer of them per address.
@Throttle({ ip: { limit: 60, ttl: 60_000 } })
@Controller("inbound")
export class InboundController {
  constructor(private readonly receiver: InboundReceiver) {}

  @Post("email")
  @Public()
  @SignedWebhook()
  @HttpCode(202)
  async receive(@Req() request: Request): Promise<{ accepted: true }> {
    const body: unknown = request.body
    if (!Buffer.isBuffer(body)) throw new NotAuthenticatedProblem("The webhook signature is missing, stale or wrong")
    await this.receiver.receive(
      {
        id: request.header("webhook-id"),
        timestamp: request.header("webhook-timestamp"),
        signature: request.header("webhook-signature"),
      },
      body,
    )
    return { accepted: true }
  }
}
