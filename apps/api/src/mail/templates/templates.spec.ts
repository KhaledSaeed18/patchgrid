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
    [{ ...base, kind: "ticket-notification", orgId: ORG, fromName: "Acme", params: { orgName: "Acme", headline: "Assigned to you — INC-000042: Printer", reason: "this ticket is assigned to you", ticketUrl: "https://acme.patchgrid.xyz/tickets/t-1", preferencesUrl: "https://acme.patchgrid.xyz/notifications/preferences", ticketId: "01a13900-0000-7000-8000-000000000042", ticketNumber: "INC-000042", replyTo: "acme@inbound.patchgrid.xyz" } }, "https://acme.patchgrid.xyz/tickets/t-1"],
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

  it("names a turned-off webhook's address as text, never a link", async () => {
    const mail = await renderMail({
      ...base,
      kind: "webhook-disabled",
      orgId: ORG,
      fromName: "Acme",
      params: { orgName: "Acme", endpointUrl: "https://hooks.example.test/in", reason: "Failed for five days without a success", settingsUrl: "https://acme.patchgrid.xyz/settings/webhooks/w-1" },
    })
    expect(mail.subject).toBe("A webhook in Acme was turned off")
    expect(mail.html).toContain('href="https://acme.patchgrid.xyz/settings/webhooks/w-1"')
    expect(mail.html).not.toContain('href="https://hooks.example.test/in"')
    expect(mail.text).toContain("https://hooks.example.test/in")
    expect(mail.text).toContain("failed for five days without a success")
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

  it("keeps a ticket notification's tenant-typed headline escaped in the body and on one line in the subject", async () => {
    const mail = await renderMail({
      ...base,
      kind: "ticket-notification",
      orgId: ORG,
      fromName: "Acme",
      params: {
        orgName: "Acme",
        headline: "New reply on INC-000001: <img src=x>\nBcc: victim@evil.test",
        reason: "you raised this ticket",
        ticketUrl: "https://acme.patchgrid.xyz/tickets/t-1",
        preferencesUrl: "https://acme.patchgrid.xyz/notifications/preferences",
        ticketId: "01a13900-0000-7000-8000-000000000001",
        ticketNumber: "INC-000001",
        replyTo: "acme@inbound.patchgrid.xyz",
      },
    })
    expect(mail.html).not.toContain("<img src=x>")
    // One line, the number bracketed where it already stood.
    expect(mail.subject).toBe("New reply on [INC-000001]: <img src=x> Bcc: victim@evil.test")
    expect(mail.text).toContain("notification preferences")
  })
})
