import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common"
import type { Request } from "express"
import { type Observable, tap } from "rxjs"

import { ActorService } from "../auth/actor"
import type { SupportReadMarks } from "../auth/support/support-read-log"

/**
 * Leaves the ids a support session's read returned on the request, for the
 * `SUPPORT_READ` the auth guard arranged to write when the response finishes
 * (ADR-0041). Writes nothing itself; a member's request passes untouched.
 */
@Injectable()
export class SupportReadInterceptor implements NestInterceptor {
  constructor(private readonly actors: ActorService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.actors.current()?.kind !== "support") return next.handle()
    const request = context.switchToHttp().getRequest<Request & SupportReadMarks>()
    return next.handle().pipe(
      tap((body: unknown) => {
        request.supportIds = idsIn(body)
      }),
    )
  }
}

/** The ids a response carries: one entity, a list, or a page of them. */
function idsIn(body: unknown): string[] {
  const idOf = (value: unknown): string[] =>
    typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" ? [value.id] : []
  if (Array.isArray(body)) return body.flatMap(idOf)
  if (typeof body === "object" && body !== null && "items" in body && Array.isArray(body.items)) return body.items.flatMap(idOf)
  return idOf(body)
}
