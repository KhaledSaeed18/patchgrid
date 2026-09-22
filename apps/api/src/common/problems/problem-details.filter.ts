import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common"
import {
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
  type ProblemError,
  type ProblemTypeSlug,
  problemTitle,
  problemTypeForStatus,
  problemTypeUrl,
} from "@patchgrid/contracts"
import type { Request, Response } from "express"
import { ZodError } from "zod"

import { ProblemException } from "./problem.exception"

type Resolved = {
  type: ProblemTypeSlug
  detail?: string
  errors?: readonly ProblemError[]
}

/**
 * Renders everything thrown anywhere in the application as RFC 9457
 * (ADR-0012). Registered globally, so there is exactly one place that decides
 * what an error looks like on the wire.
 *
 * The rule that matters: **a 5xx never leaks internals.** The real error goes to
 * the log with a correlation id; the client gets that id and nothing else. A
 * stack trace in a response body is a gift to whoever is probing you.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const response = http.getResponse<Response>()
    const request = http.getRequest<Request & { id?: string; log?: Logger }>()

    // Health endpoints are operational, not part of the API contract. Terminus
    // signals a failed readiness check by throwing a 503 whose body names which
    // indicator is down — rendering that as Problem Details would discard the
    // detail an orchestrator needs AND relabel 503 as 500, which reads as "the
    // app is broken" rather than "do not route traffic here yet".
    if (isOperationalPath(request) && exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse())
      return
    }

    const resolved = resolve(exception)
    const status = statusFor(resolved.type)
    const correlationId = typeof request.id === "string" ? request.id : undefined

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Log the real thing, once, with the id the client is about to be shown.
      request.log?.error(
        { err: exception, correlationId },
        "unhandled exception rendered as 500",
      )
    }

    const body: ProblemDetails = {
      type: problemTypeUrl(resolved.type),
      title: problemTitle(resolved.type),
      status,
      ...(resolved.detail === undefined ? {} : { detail: resolved.detail }),
      ...(request.originalUrl === undefined ? {} : { instance: request.originalUrl }),
      ...(resolved.errors === undefined ? {} : { errors: [...resolved.errors] }),
      // Only on 5xx: on a 4xx the client already knows what it did wrong, and a
      // correlation id would invite support requests for its own mistakes.
      ...(status >= HttpStatus.INTERNAL_SERVER_ERROR && correlationId !== undefined
        ? { correlationId }
        : {}),
    }

    response.status(status).type(PROBLEM_CONTENT_TYPE).json(body)
  }
}

type Logger = { error: (obj: unknown, msg?: string) => void }

/** Paths served outside the `/api/v1` prefix, which have their own conventions. */
function isOperationalPath(request: { originalUrl?: string; url?: string }): boolean {
  const path = request.originalUrl ?? request.url ?? ""
  return path === "/health" || path.startsWith("/health/")
}

function statusFor(type: ProblemTypeSlug): number {
  return new ProblemException(type).status
}

function resolve(exception: unknown): Resolved {
  // 1. Something the application threw on purpose.
  if (exception instanceof ProblemException) {
    return {
      type: exception.problemType,
      ...(exception.detail === undefined ? {} : { detail: exception.detail }),
      ...(exception.errors === undefined ? {} : { errors: exception.errors }),
    }
  }

  // 2. Schema validation, from the nestjs-zod pipe or a manual parse.
  const zodError = asZodError(exception)
  if (zodError !== null) {
    return {
      type: "validation-failed",
      detail: "The request failed validation",
      errors: zodError.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
        code: issue.code,
      })),
    }
  }

  // 3. A framework or third-party HttpException — a 404 from the router, say.
  if (exception instanceof HttpException) {
    const status = exception.getStatus()
    const type = problemTypeForStatus(status)
    // Nest's own messages are safe to surface for 4xx; 5xx text may not be.
    const detail =
      status < HttpStatus.INTERNAL_SERVER_ERROR ? messageOf(exception) : undefined
    return { type, ...(detail === undefined ? {} : { detail }) }
  }

  // 4. Anything else is a bug. Say nothing.
  return { type: "internal-error" }
}

/** nestjs-zod wraps ZodError, so check the cause chain as well as the value. */
function asZodError(exception: unknown): ZodError | null {
  if (exception instanceof ZodError) return exception
  if (exception instanceof Error && exception.cause instanceof ZodError) {
    return exception.cause
  }
  if (
    exception instanceof HttpException &&
    typeof exception.getResponse() === "object"
  ) {
    const body = exception.getResponse() as { errors?: unknown }
    if (body.errors instanceof ZodError) return body.errors
  }
  return null
}

function messageOf(exception: HttpException): string | undefined {
  const response = exception.getResponse()
  if (typeof response === "string") return response
  if (typeof response === "object" && response !== null) {
    const { message } = response as { message?: unknown }
    if (typeof message === "string") return message
    if (Array.isArray(message)) return message.join("; ")
  }
  return undefined
}
