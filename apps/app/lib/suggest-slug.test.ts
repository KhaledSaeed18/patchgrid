// @vitest-environment node
import { slugSchema } from "@patchgrid/contracts"
import { describe, expect, it } from "vitest"

import { suggestSlug } from "./suggest-slug"

describe("suggestSlug", () => {
  it("turns a workspace name into an address the slug rule accepts", () => {
    expect(suggestSlug("Acme Corp, Ltd.")).toBe("acme-corp-ltd")
    expect(suggestSlug("  Café  Réseau ")).toBe("cafe-reseau")
    const long = suggestSlug(
      "The Extraordinarily Long Name Of A Help Desk Team"
    )
    expect(slugSchema.safeParse(long).success).toBe(true)
    expect(long.endsWith("-")).toBe(false)
  })
})
