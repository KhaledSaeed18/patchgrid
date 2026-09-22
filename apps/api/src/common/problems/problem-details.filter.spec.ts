import { HttpException, HttpStatus, NotFoundException } from "@nestjs/common"
import { PROBLEM_CONTENT_TYPE } from "@patchgrid/contracts"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { ProblemDetailsFilter } from "./problem-details.filter"
import {
  InvalidTransitionProblem,
  NotFoundProblem,
  PlanLimitProblem,
  StaleWriteProblem,
} from "./problem.exception"

function render(exception: unknown, url = "/api/v1/tickets/x") {
  const json = vi.fn()
  const type = vi.fn().mockReturnValue({ json })
  const status = vi.fn().mockReturnValue({ type, json })
  const error = vi.fn()

  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ id: "req-123", originalUrl: url, log: { error } }),
    }),
  } as never

  new ProblemDetailsFilter().catch(exception, host)

  return {
    status: status.mock.calls[0]?.[0] as number,
    contentType: type.mock.calls[0]?.[0] as string,
    body: json.mock.calls[0]?.[0] as Record<string, unknown>,
    logged: error.mock.calls.length,
  }
}

describe("ProblemDetailsFilter", () => {
  it("renders a domain problem with its type URI", () => {
    const result = render(new NotFoundProblem("No such ticket"))
    expect(result.status).toBe(404)
    expect(result.contentType).toBe(PROBLEM_CONTENT_TYPE)
    expect(result.body).toMatchObject({
      type: "https://patchgrid.xyz/problems/not-found",
      title: "Not found",
      status: 404,
      detail: "No such ticket",
      instance: "/api/v1/tickets/x",
    })
  })

  it("carries the current status and attempted action on an invalid transition", () => {
    const result = render(new InvalidTransitionProblem("RESOLVED", "start"))
    expect(result.status).toBe(409)
    expect(result.body.detail).toBe("Cannot 'start' a ticket in status 'RESOLVED'")
  })

  it("uses 402 only for plan limits", () => {
    expect(render(new PlanLimitProblem("agent seats")).status).toBe(402)
  })

  it("maps a stale write to 409 so the UI can offer a reload", () => {
    expect(render(new StaleWriteProblem()).status).toBe(409)
  })

  it("expands a ZodError into field errors a form can map", () => {
    const error = z.object({ slug: z.string().min(3) }).safeParse({ slug: "a" }).error
    const result = render(error)
    expect(result.status).toBe(400)
    expect(result.body.errors).toEqual([
      expect.objectContaining({ path: "slug", code: "too_small" }),
    ])
  })

  it("maps a framework HttpException by status", () => {
    const result = render(new NotFoundException("Cannot GET /nope"))
    expect(result.status).toBe(404)
    expect(result.body.type).toBe("https://patchgrid.xyz/problems/not-found")
  })

  it("never leaks internals from an unexpected error", () => {
    const result = render(new Error("connection string postgres://user:hunter2@db/x failed"))
    expect(result.status).toBe(500)
    expect(result.body.detail).toBeUndefined()
    expect(JSON.stringify(result.body)).not.toContain("hunter2")
    // The real error is logged once, with the id the client was shown.
    expect(result.logged).toBe(1)
    expect(result.body.correlationId).toBe("req-123")
  })

  it("does not put a correlation id on 4xx", () => {
    // A client that sent a bad request does not need a support reference.
    expect(render(new NotFoundProblem()).body.correlationId).toBeUndefined()
  })

  it("leaves health responses alone", () => {
    // Terminus signals a failed readiness check with a 503 whose body names the
    // indicator that is down. Rewriting that as Problem Details would discard
    // the detail an orchestrator needs and relabel 503 as 500.
    const terminus = new HttpException(
      { status: "error", details: { redis: { status: "down" } } },
      HttpStatus.SERVICE_UNAVAILABLE,
    )
    const result = render(terminus, "/health/ready")
    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ status: "error" })
  })

  it("does not surface 5xx text from a framework exception", () => {
    const result = render(
      new HttpException("internal detail leaked here", HttpStatus.INTERNAL_SERVER_ERROR),
    )
    expect(result.status).toBe(500)
    expect(result.body.detail).toBeUndefined()
  })
})
