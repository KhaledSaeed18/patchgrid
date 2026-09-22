import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Placeholder } from "./placeholder"

describe("Placeholder", () => {
  it("names the surface and the milestone it arrives in", () => {
    render(
      <Placeholder surface="console" milestone="M2">
        Queues and triage.
      </Placeholder>
    )
    // An empty page should never be mistaken for a lost one, so both are visible.
    expect(screen.getByText(/console/)).toBeInTheDocument()
    expect(screen.getByText(/M2/)).toBeInTheDocument()
    expect(screen.getByText("Queues and triage.")).toBeInTheDocument()
  })

  it("always offers a way back", () => {
    render(
      <Placeholder surface="portal" milestone="M2">
        My tickets.
      </Placeholder>
    )
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute(
      "href",
      "/"
    )
  })
})
