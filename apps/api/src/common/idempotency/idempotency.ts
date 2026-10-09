import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
  SetMetadata,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { Request, Response } from "express"
import { createHash } from "node:crypto"
import { from, lastValueFrom, type Observable } from "rxjs"

import { ActorService } from "../../auth/actor"
import { RedisService } from "../../redis/redis.service"
import { TenantContextService } from "../../tenancy/tenant-context.service"
import { ConflictProblem, ValidationProblem } from "../problems/problem.exception"

const IDEMPOTENT = Symbol("IDEMPOTENT")

/** Marks an entity-creating POST whose `Idempotency-Key` is honoured (ADR-0012). */
export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT, true)

/** How long a key remembers its answer. A client retrying after a day is making a new request. */
const TTL_SECONDS = 24 * 60 * 60
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

type Stored = { state: "pending"; bodyHash: string } | { state: "done"; bodyHash: string; status: number; body: unknown }

/**
 * `Idempotency-Key` on entity-creating POSTs (ADR-0012, ENGINEERING.md). The
 * first request with a key claims it and, on success, stores its answer; a
 * retry with the same key and body gets that answer again instead of a second
 * entity. The same key with a different body, or while the first is still
 * running, is a 409. Keys are scoped to the workspace, the actor and the
 * route, so one client's key can never replay another's answer.
 *
 * A failed request releases its key, so it can be retried. With Redis down
 * the request proceeds un-deduplicated and says so in the log: refusing every
 * create during an outage would be the worse failure.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name)

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    private readonly actors: ActorService,
    private readonly tenant: TenantContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.reflector.get<boolean>(IDEMPOTENT, context.getHandler()) !== true) return next.handle()
    const request = context.switchToHttp().getRequest<Request>()
    const header = request.headers["idempotency-key"]
    if (header === undefined) return next.handle()
    const key = Array.isArray(header) ? header[0] : header
    if (key === undefined || !KEY_PATTERN.test(key)) {
      throw new ValidationProblem([
        { path: "Idempotency-Key", message: "must be 8 to 128 letters, digits, - or _", code: "invalid_idempotency_key" },
      ])
    }
    return from(this.run(context, request, key, next))
  }

  private async run(context: ExecutionContext, request: Request, key: string, next: CallHandler): Promise<unknown> {
    const response = context.switchToHttp().getResponse<Response>()
    const slot = this.slotFor(request, key)
    const bodyHash = createHash("sha256").update(JSON.stringify(request.body ?? null)).digest("hex")

    let claimed: boolean
    try {
      claimed = (await this.redis.client.set(slot, JSON.stringify({ state: "pending", bodyHash } satisfies Stored), "EX", TTL_SECONDS, "NX")) === "OK"
    } catch {
      this.logger.warn({ msg: "idempotency store unavailable; proceeding without", route: request.path })
      return lastValueFrom(next.handle())
    }

    if (!claimed) {
      const stored = await this.read(slot)
      if (stored === null) return lastValueFrom(next.handle())
      if (stored.bodyHash !== bodyHash) throw new ConflictProblem("This Idempotency-Key was used for a different request")
      if (stored.state === "pending") throw new ConflictProblem("A request with this Idempotency-Key is still in progress")
      response.status(stored.status)
      response.setHeader("Idempotent-Replayed", "true")
      return stored.body
    }

    try {
      const body = await lastValueFrom(next.handle())
      const done: Stored = { state: "done", bodyHash, status: response.statusCode, body }
      await this.redis.client.set(slot, JSON.stringify(done), "EX", TTL_SECONDS).catch(() => undefined)
      return body
    } catch (error) {
      await this.redis.client.del(slot).catch(() => undefined)
      throw error
    }
  }

  private slotFor(request: Request, key: string): string {
    const actor = this.actors.current()
    const who =
      actor === undefined
        ? "anonymous"
        : actor.kind === "identity"
          ? `user:${actor.userId}`
          : `member:${actor.membershipId}`
    const org = this.tenant.current()?.orgId ?? "platform"
    return `idem:${org}:${who}:${request.method}:${request.route?.path ?? request.path}:${key}`
  }

  private async read(slot: string): Promise<Stored | null> {
    const raw = await this.redis.client.get(slot).catch(() => null)
    if (raw === null) return null
    try {
      return JSON.parse(raw) as Stored
    } catch {
      return null
    }
  }
}
