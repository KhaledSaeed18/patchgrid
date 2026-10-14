import type { ExecutionContext } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import { Reflector } from "@nestjs/core"

import { SignedWebhook } from "../common/decorators/route-markers"
import { NotPermittedProblem } from "../common/problems/problem.exception"
import { RequestedWithGuard } from "./requested-with.guard"

class Plain {
  handle(): void {}
}
@SignedWebhook()
class Hook {
  handle(): void {}
}

const context = (method: string, headers: Record<string, string> = {}, target: typeof Plain | typeof Hook = Plain) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
    getHandler: () => target.prototype.handle,
    getClass: () => target,
  }) as unknown as ExecutionContext

describe("RequestedWithGuard", () => {
  const guard = new RequestedWithGuard(new Reflector())

  it("exempts a signed webhook, whose credential is no cookie", () => {
    expect(guard.canActivate(context("POST", {}, Hook))).toBe(true)
  })

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
