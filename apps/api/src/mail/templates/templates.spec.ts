import { describe, expect, it } from "vitest"

import { type MailJob, mailJobSchema, renderMail } from "./index"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const base = { to: "someone@acme.test", orgId: null, fromName: "Patchgrid" }

describe("mail templates", () => {
  it.each<[MailJob, string]>([
    [{ ...base, kind: "verify-email", params: { name: "Sam", verifyUrl: "https://app.patchgrid.xyz/verify?token=abc", expiresInHours: 24 } }, "https://app.patchgrid.xyz/verify?token=abc"],
    [{ ...base, kind: "account-exists", params: { name: "Sam", loginUrl: "https://app.patchgrid.xyz/login", resetUrl: "https://app.patchgrid.xyz/reset" } }, "https://app.patchgrid.xyz/login"],
    [{ ...base, kind: "invite", orgId: ORG, fromName: "Acme", params: { orgName: "Acme", inviterName: "Ada", role: "AGENT", acceptUrl: "https://app.patchgrid.xyz/invite?token=abc", expiresInDays: 7 } }, "https://app.patchgrid.xyz/invite?token=abc"],
    [{ ...base, kind: "reset-password", params: { name: "Sam", resetUrl: "https://app.patchgrid.xyz/reset?token=abc", expiresInMinutes: 30 } }, "https://app.patchgrid.xyz/reset?token=abc"],
  ])("renders %o with its link in both html and text", async (job, link) => {
    const mail = await renderMail(job)
    expect(mail.subject.length).toBeGreaterThan(10)
    expect(mail.html).toContain("<!DOCTYPE html")
    expect(mail.html).toContain(`href="${link}"`)
    expect(mail.text).toContain(link)
    expect(mail.text).not.toContain("<")
  })

  it("escapes what tenants type", async () => {
    const mail = await renderMail({
      ...base,
      kind: "invite",
      orgId: ORG,
      fromName: "Acme",
      params: { orgName: "<script>alert(1)</script>", inviterName: "Ada & co", role: "AGENT", acceptUrl: "https://app.patchgrid.xyz/i", expiresInDays: 7 },
    })
    expect(mail.html).not.toContain("<script>")
    expect(mail.html).toContain("&lt;script&gt;")
    expect(mail.subject).toBe("You're invited to <script>alert(1)</script> on Patchgrid")
  })

  it("names the organization in the invitation subject", async () => {
    const mail = await renderMail({ ...base, kind: "invite", orgId: ORG, fromName: "Acme", params: { orgName: "Acme", inviterName: "Ada", role: "AGENT", acceptUrl: "https://a.b/", expiresInDays: 7 } })
    expect(mail.subject).toBe("You're invited to Acme on Patchgrid")
  })
})

describe("mailJobSchema", () => {
  it("rejects an unknown kind, a bad address and a non-URL link", () => {
    expect(mailJobSchema.safeParse({ ...base, kind: "newsletter", params: {} }).success).toBe(false)
    expect(mailJobSchema.safeParse({ ...base, to: "nope", kind: "verify-email", params: { name: "S", verifyUrl: "https://a.b/", expiresInHours: 1 } }).success).toBe(false)
    expect(mailJobSchema.safeParse({ ...base, kind: "verify-email", params: { name: "S", verifyUrl: "javascript:alert(1)", expiresInHours: 1 } }).success).toBe(false)
  })

  it("normalises the address like every other email in the system", () => {
    const parsed = mailJobSchema.parse({ ...base, to: " Someone@Acme.TEST ", kind: "reset-password", params: { name: "S", resetUrl: "https://a.b/", expiresInMinutes: 30 } })
    expect(parsed.to).toBe("someone@acme.test")
  })
})
