import { describe, expect, it } from "vitest"

import { automaticReason } from "./auto-reply"
import { slugFromRecipient } from "./recipient"
import { REPLY_ABOVE_LINE, replyText } from "./reply-text"
import { sign, verifySignature } from "./signature"
import { ticketMessageId, ticketReference, titleFromSubject } from "./threading"
import { verdictFrom } from "./verdict"

const SECRET = "whsec_cGF0Y2hncmlkLWxvY2FsLWluYm91bmQtc2VjcmV0"
const NOW = new Date("2026-10-15T10:00:00Z")
const ts = String(Math.floor(NOW.getTime() / 1000))

describe("the webhook signature", () => {
  const body = Buffer.from('{"type":"email.received"}')
  const signed = { id: "msg_1", timestamp: ts, signature: sign(SECRET, "msg_1", ts, body) }

  it("accepts the bytes it signed, among several signatures", () => {
    expect(verifySignature(SECRET, signed, body, NOW)).toEqual({ ok: true })
    expect(verifySignature(SECRET, { ...signed, signature: `v1,b2xk ${signed.signature}` }, body, NOW)).toEqual({ ok: true })
  })

  it("refuses other bytes, another secret, a missing header and a stale timestamp", () => {
    expect(verifySignature(SECRET, signed, Buffer.from('{"type":"email.received" }'), NOW)).toEqual({ ok: false, reason: "mismatch" })
    expect(verifySignature("whsec_b3RoZXItc2VjcmV0LW90aGVyLXNlY3JldA==", signed, body, NOW)).toEqual({ ok: false, reason: "mismatch" })
    expect(verifySignature(SECRET, { ...signed, id: undefined }, body, NOW)).toEqual({ ok: false, reason: "missing" })
    expect(verifySignature(SECRET, signed, body, new Date(NOW.getTime() + 6 * 60_000))).toEqual({ ok: false, reason: "stale" })
  })
})

describe("the verdict", () => {
  const ID = "mx.inbound.lvh.me"
  const pass = `${ID}; spf=pass smtp.mailfrom=patchgrid.test; dkim=pass header.d=patchgrid.test; dmarc=pass (p=none) header.from=patchgrid.test`

  it("is PASS only for an aligned DMARC pass in our own receiver's header", () => {
    expect(verdictFrom([pass], ID, "rita@patchgrid.test")).toBe("PASS")
    expect(verdictFrom([pass], ID, "rita@elsewhere.test")).toBe("FAIL")
    expect(verdictFrom([pass.replace("dmarc=pass", "dmarc=fail")], ID, "rita@patchgrid.test")).toBe("FAIL")
  })

  it("ignores a header the sender wrote, and a pass hidden in a comment", () => {
    expect(verdictFrom([pass.replace(ID, "mx.attacker.test")], ID, "rita@patchgrid.test")).toBe("NONE")
    // Ours comes first (topmost); a forged pass below it changes nothing.
    expect(verdictFrom([`${ID}; spf=fail; dmarc=fail header.from=patchgrid.test`, pass], ID, "rita@patchgrid.test")).toBe("FAIL")
    expect(verdictFrom([`${ID}; spf=none (dmarc=pass header.from=patchgrid.test)`], ID, "rita@patchgrid.test")).toBe("NONE")
    expect(verdictFrom([], ID, "rita@patchgrid.test")).toBe("NONE")
  })
})

describe("automatic mail", () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name]
  it("knows bounces, out-of-office and list mail, and lets a person's mail through", () => {
    expect(automaticReason(headers({ "auto-submitted": "auto-replied" }), "rita@x.test")).toMatch(/Auto-Submitted/)
    expect(automaticReason(headers({ precedence: "bulk" }), "rita@x.test")).toMatch(/Precedence/)
    expect(automaticReason(headers({ "list-id": "<it.x.test>" }), "rita@x.test")).toBe("mailing list")
    expect(automaticReason(headers({ "content-type": "multipart/report; report-type=delivery-status" }), "x@x.test")).toBe("delivery report")
    expect(automaticReason(headers({}), "MAILER-DAEMON@x.test")).toBe("bounce")
    expect(automaticReason(headers({ "auto-submitted": "no" }), "rita@x.test")).toBeNull()
  })
})

describe("threading", () => {
  const id = "01a13900-0000-7000-8000-000000000042"
  const domain = "inbound.lvh.me"

  it("finds our own Message-ID before a subject tag, and only at our domain", () => {
    const ours = ticketMessageId(id, "x1", domain)
    expect(ticketReference({ inReplyTo: ours, references: [], subject: "Re: [INC-000007] hi", inboundDomain: domain })).toEqual({ kind: "id", ticketId: id })
    expect(ticketReference({ inReplyTo: undefined, references: ["<a@b>", ours], subject: "", inboundDomain: domain })).toEqual({ kind: "id", ticketId: id })
    expect(ticketReference({ inReplyTo: `<t.${id}.x1@attacker.test>`, references: [], subject: "Re: [INC-000007] hi", inboundDomain: domain })).toEqual({
      kind: "number",
      type: "INCIDENT",
      number: 7,
    })
    expect(ticketReference({ inReplyTo: undefined, references: [], subject: "Printer", inboundDomain: domain })).toBeNull()
  })

  it("makes a title of a subject", () => {
    expect(titleFromSubject("RE: Fwd: [INC-000042] Printer jammed\r\n again")).toBe("Printer jammed again")
    expect(titleFromSubject("   ")).toBe("(no subject)")
    expect(titleFromSubject("x".repeat(300))).toHaveLength(200)
  })
})

describe("reply text", () => {
  it("keeps what was written, not what was quoted", () => {
    expect(replyText(`Still broken.\n\n${REPLY_ABOVE_LINE}\nSam replied: …`)).toBe("Still broken.")
    expect(replyText("Thanks!\r\n\r\nOn Tue, 14 Oct 2026 at 09:00, Sam <s@x> wrote:\r\n> Try again")).toBe("Thanks!")
    expect(replyText("Fixed now\n-- \nRita\nFinance")).toBe("Fixed now")
    expect(replyText("> only a quote")).toBe("> only a quote")
  })
})

describe("the recipient", () => {
  it("names a slug at our inbound host, sub-addresses included", () => {
    expect(slugFromRecipient("Acme@Inbound.lvh.me", "lvh.me")).toBe("acme")
    expect(slugFromRecipient("acme+billing@inbound.lvh.me", "lvh.me")).toBe("acme")
    expect(slugFromRecipient("acme@lvh.me", "lvh.me")).toBeNull()
    expect(slugFromRecipient("acme@inbound.evil.test", "lvh.me")).toBeNull()
    expect(slugFromRecipient("-bad@inbound.lvh.me", "lvh.me")).toBeNull()
  })
})
