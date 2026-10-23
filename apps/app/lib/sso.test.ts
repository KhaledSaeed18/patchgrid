import { SSO_ERROR_CODES } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import { SSO_ERROR_MESSAGE, ssoErrorFrom, ssoStartUrl } from "./sso"

describe("ssoStartUrl", () => {
  it("goes to the API's start route by email or by workspace", () => {
    expect(ssoStartUrl({ email: "kim@acme.test" })).toBe(
      "http://api.lvh.me:4000/api/v1/auth/sso/start?email=kim%40acme.test"
    )
    expect(
      ssoStartUrl(
        { slug: "acme" },
        { intent: "step-up", next: "/settings/sso" }
      )
    ).toBe(
      "http://api.lvh.me:4000/api/v1/auth/sso/start?slug=acme&intent=step-up&next=%2Fsettings%2Fsso"
    )
  })

  it("drops a return that would leave the workspace", () => {
    expect(
      ssoStartUrl({ slug: "acme" }, { next: "//evil.example/" })
    ).not.toContain("next=")
    expect(
      ssoStartUrl({ slug: "acme" }, { next: "https://evil.example/" })
    ).not.toContain("next=")
  })
})

describe("ssoErrorFrom", () => {
  it("reads only our own codes", () => {
    expect(ssoErrorFrom("email")).toBe("email")
    expect(ssoErrorFrom("<script>")).toBeNull()
    expect(ssoErrorFrom(undefined)).toBeNull()
    expect(ssoErrorFrom(["email"])).toBeNull()
  })

  it("has words for every code", () => {
    for (const code of SSO_ERROR_CODES)
      expect(SSO_ERROR_MESSAGE[code].length).toBeGreaterThan(10)
  })
})
