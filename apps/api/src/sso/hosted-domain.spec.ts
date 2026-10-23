import { describe, expect, it } from "vitest"

import { hostedDomainAdmits, requiresHostedDomain } from "./hosted-domain"

describe("hosted domain", () => {
  it("is asked of Google's shared issuer, however it is written", () => {
    expect(requiresHostedDomain("https://accounts.google.com")).toBe(true)
    expect(requiresHostedDomain("https://accounts.google.com/")).toBe(true)
    expect(requiresHostedDomain("accounts.google.com")).toBe(true)
    expect(requiresHostedDomain("https://idp.acme.test/realms/acme")).toBe(false)
  })

  it("admits Google only for the workspace's own hosted domain", () => {
    expect(hostedDomainAdmits("https://accounts.google.com", "acme.test", "acme.test")).toBe(true)
    expect(hostedDomainAdmits("https://accounts.google.com", "ACME.test", "acme.test")).toBe(true)
    // An unmanaged Google account made with an Acme address carries no `hd`.
    expect(hostedDomainAdmits("https://accounts.google.com", null, "acme.test")).toBe(false)
    expect(hostedDomainAdmits("https://accounts.google.com", "globex.test", "acme.test")).toBe(false)
  })

  it("leaves a workspace's own provider alone", () => {
    expect(hostedDomainAdmits("https://idp.acme.test", null, "acme.test")).toBe(true)
  })
})
