import { describe, expect, it } from "vitest"

import { RESERVED_SLUGS } from "./reserved-slugs.ts"
import { checkSlugFormat, slugSchema } from "./slug.ts"

describe("slugSchema", () => {
  it.each(["acme", "acme-corp", "a1b", "globex-industries-ltd", "x0-9y"])(
    "accepts %s",
    (value) => {
      expect(slugSchema.safeParse(value).success).toBe(true)
    },
  )

  it.each([
    ["ab", "too short"],
    ["-acme", "leading hyphen"],
    ["acme-", "trailing hyphen"],
    ["ac--me", "double hyphen — would collide with the punycode xn-- prefix"],
    ["Acme", "uppercase"],
    ["acme corp", "space"],
    ["acme_corp", "underscore"],
    ["acme.corp", "dot would create a nested subdomain the wildcard cert cannot cover"],
    ["a".repeat(31), "too long"],
  ])("rejects %s (%s)", (value) => {
    expect(slugSchema.safeParse(value).success).toBe(false)
  })

  it("rejects reserved slugs even though they are well formed", () => {
    expect(slugSchema.safeParse("api").success).toBe(false)
    expect(slugSchema.safeParse("inbound").success).toBe(false)
  })
})

describe("checkSlugFormat", () => {
  it("names the reason so the signup form can explain it", () => {
    expect(checkSlugFormat("ab")).toBe("too-short")
    expect(checkSlugFormat("a".repeat(31))).toBe("too-long")
    expect(checkSlugFormat("ac--me")).toBe("invalid-characters")
    expect(checkSlugFormat("admin")).toBe("reserved")
    expect(checkSlugFormat("acme")).toBeNull()
  })
})

describe("RESERVED_SLUGS", () => {
  it("contains every hostname the platform actually serves", () => {
    // If a new public hostname is added without its label here, a tenant can
    // claim it and shadow real infrastructure (docs/DNS.md §1).
    for (const host of ["www", "app", "api", "admin", "files", "inbound"]) {
      expect(RESERVED_SLUGS.has(host)).toBe(true)
    }
  })

  it("only contains entries that would otherwise be legal slugs", () => {
    // A reserved entry that could never be typed is dead weight and hides a typo.
    for (const reserved of RESERVED_SLUGS) {
      expect(
        checkSlugFormat(reserved),
        `${reserved} is not a well-formed slug, so reserving it does nothing`,
      ).toBe("reserved")
    }
  })
})
