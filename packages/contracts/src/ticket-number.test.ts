import { describe, expect, it } from "vitest"

import {
  findTicketNumberInSubject,
  formatTicketNumber,
  parseTicketNumber,
  TICKET_TYPE_PREFIX,
  ticketTypeSchema,
} from "./ticket-number.ts"

describe("formatTicketNumber", () => {
  it.each([
    ["INCIDENT", 42, "INC-000042"],
    ["SERVICE_REQUEST", 7, "SR-000007"],
    ["PROBLEM", 3, "PRB-000003"],
    ["CHANGE", 11, "CHG-000011"],
  ] as const)("%s %i → %s", (type, number, expected) => {
    expect(formatTicketNumber(type, number)).toBe(expected)
  })

  it("does not truncate past the padding width", () => {
    expect(formatTicketNumber("INCIDENT", 1234567)).toBe("INC-1234567")
  })

  it("has a prefix for every ticket type", () => {
    for (const type of ticketTypeSchema.options) {
      expect(TICKET_TYPE_PREFIX[type]).toBeTruthy()
    }
  })
})

describe("parseTicketNumber", () => {
  it("round-trips every type", () => {
    for (const type of ticketTypeSchema.options) {
      expect(parseTicketNumber(formatTicketNumber(type, 42))).toEqual({ type, number: 42 })
    }
  })

  it("is lenient about what a human retypes", () => {
    expect(parseTicketNumber("inc-42")).toEqual({ type: "INCIDENT", number: 42 })
    expect(parseTicketNumber("  INC-000042  ")).toEqual({ type: "INCIDENT", number: 42 })
  })

  it("returns a null type for a bare number, so search spans every type", () => {
    expect(parseTicketNumber("42")).toEqual({ type: null, number: 42 })
    expect(parseTicketNumber("#42")).toEqual({ type: null, number: 42 })
  })

  it.each(["", "INC-", "-42", "XYZ-1", "INC-abc", "not a ticket"])(
    "rejects %s",
    (value) => {
      expect(parseTicketNumber(value)).toBeNull()
    },
  )
})

describe("findTicketNumberInSubject", () => {
  it("extracts the reference an email reply carries", () => {
    expect(findTicketNumberInSubject("Re: [INC-000042] Printer on fire")).toEqual({
      type: "INCIDENT",
      number: 42,
    })
  })

  it("ignores a bracketed number with no type, which could match anything", () => {
    expect(findTicketNumberInSubject("Re: [42] something")).toBeNull()
  })

  it("returns null when there is no reference", () => {
    expect(findTicketNumberInSubject("Printer on fire")).toBeNull()
  })
})
