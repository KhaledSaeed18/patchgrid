import { LINK_KINDS_FROM, linkKindSchema, ticketTypeSchema } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import { canonicalLink, readFrom } from "./links"

const inc = { id: "b-incident", type: "INCIDENT" as const }
const inc2 = { id: "a-incident", type: "INCIDENT" as const }
const sr = { id: "c-request", type: "SERVICE_REQUEST" as const }
const prb = { id: "d-problem", type: "PROBLEM" as const }
const chg = { id: "e-change", type: "CHANGE" as const }

describe("links, stored once and read from both ends (DOMAIN.md §1)", () => {
  it("stores a reading and its reverse as the same row", () => {
    expect(canonicalLink("CAUSED_BY", inc, prb)).toEqual(canonicalLink("CAUSES", prb, inc))
    expect(canonicalLink("RESOLVED_BY", prb, chg)).toEqual(canonicalLink("RESOLVES", chg, prb))
    expect(canonicalLink("DUPLICATE_OF", inc, inc2)).toEqual(canonicalLink("HAS_DUPLICATE", inc2, inc))
    expect(canonicalLink("CAUSED_BY", inc, prb)).toEqual({ ok: true, link: { fromTicketId: inc.id, toTicketId: prb.id, relation: "CAUSED_BY" } })
  })

  it("normalises RELATES_TO lower id first, whichever end asks", () => {
    expect(canonicalLink("RELATES_TO", inc, inc2)).toEqual({ ok: true, link: { fromTicketId: "a-incident", toTicketId: "b-incident", relation: "RELATES_TO" } })
    expect(canonicalLink("RELATES_TO", inc2, inc)).toEqual(canonicalLink("RELATES_TO", inc, inc2))
    expect(canonicalLink("RELATES_TO", chg, sr)).toMatchObject({ ok: true })
  })

  it("refuses a self-link and a relation between the wrong types", () => {
    expect(canonicalLink("RELATES_TO", inc, inc)).toMatchObject({ ok: false })
    expect(canonicalLink("CAUSED_BY", sr, prb)).toMatchObject({ ok: false })
    expect(canonicalLink("CAUSED_BY", prb, inc)).toMatchObject({ ok: false })
    expect(canonicalLink("RESOLVED_BY", inc, chg)).toMatchObject({ ok: false })
    expect(canonicalLink("DUPLICATE_OF", inc, sr)).toMatchObject({ ok: false })
    expect(canonicalLink("DUPLICATE_OF", prb, { id: "f", type: "PROBLEM" })).toMatchObject({ ok: false })
  })

  it("reads every kind back as it was asked, from the asking end", () => {
    const pairs = { CAUSED_BY: [inc, prb], CAUSES: [prb, inc], RESOLVED_BY: [prb, chg], RESOLVES: [chg, prb], DUPLICATE_OF: [inc, inc2], HAS_DUPLICATE: [inc2, inc], RELATES_TO: [inc, chg] } as const
    for (const kind of linkKindSchema.options) {
      const [self, other] = pairs[kind]
      const made = canonicalLink(kind, self, other)
      if (!made.ok) throw new Error(made.reason)
      expect(readFrom(made.link, self.id)).toBe(kind)
    }
  })
})

describe("the kinds a form offers (LINK_KINDS_FROM)", () => {
  it("are exactly the kinds the API accepts from that type, against some other type", () => {
    for (const selfType of ticketTypeSchema.options) {
      const accepted = linkKindSchema.options.filter((kind) =>
        ticketTypeSchema.options.some((otherType) => canonicalLink(kind, { id: "a", type: selfType }, { id: "b", type: otherType }).ok),
      )
      expect(accepted.toSorted(), selfType).toEqual([...LINK_KINDS_FROM[selfType]].toSorted())
    }
  })
})
