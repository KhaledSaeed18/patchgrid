import type { ExecutionContext } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import { NotPermittedProblem } from "../common/problems/problem.exception"
import { RequestedWithGuard } from "./requested-with.guard"

const context = (method: string, headers: Record<string, string> = {}) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ method, headers }) }) }) as unknown as ExecutionContext

describe("RequestedWithGuard", () => {
  const guard = new RequestedWithGuard()

  it("lets safe methods through without the header", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(guard.canActivate(context(method))).toBe(true)
  })

  it("refuses a cookie-borne mutation without the header, including login", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() => guard.canActivate(context(method))).toThrow(NotPermittedProblem)
    }
    expect(() => guard.canActivate(context("POST", { "x-requested-with": "XMLHttpRequest" }))).toThrow(NotPermittedProblem)
  })

  it("accepts the header, and exempts bearer-token requests a browser cannot forge", () => {
    expect(guard.canActivate(context("POST", { "x-requested-with": "patchgrid" }))).toBe(true)
    expect(guard.canActivate(context("DELETE", { authorization: "Bearer pg_a_b" }))).toBe(true)
  })
})
