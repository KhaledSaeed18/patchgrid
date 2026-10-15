import { expect, test } from "@playwright/test"

import { signIn, transition } from "./support/session"
import {
  ACME,
  people,
  runId,
  SEED_PASSWORD,
  workspaceOrigin,
} from "./support/stack"

/**
 * A Change from draft to closed (DOMAIN.md §2.3): an agent drafts it with a
 * plan and submits it; an admin who did not raise it approves; the agent
 * implements and closes. The requester of a change never approves their own.
 */
const title = `Rotate the core switch firmware (${runId})`

/** `datetime-local` wants local time without a zone, to the minute. */
function local(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

test("draft → submit → approve by someone else → implement → close", async ({
  browser,
  page,
}) => {
  await signIn(page, people.sam.email, SEED_PASSWORD, ACME)
  await page.goto(`${workspaceOrigin(ACME)}/tickets/new?type=CHANGE`)
  await page.fill("#ticket-title", title)
  await page.fill(
    "#ticket-description",
    "Vendor advisory 2026-41; 20-minute outage at the core."
  )
  // Inside the hour before the window opens, so starting needs no "early" confirmation.
  const start = new Date(Date.now() + 30 * 60_000)
  await page.fill("#plannedStart", local(start))
  await page.fill("#plannedEnd", local(new Date(start.getTime() + 60 * 60_000)))
  await page.selectOption("#risk", "MEDIUM")
  await page.fill(
    "textarea[name=implementationPlan]",
    "Stage the image, fail over to the secondary, flash, fail back."
  )
  await page.fill(
    "textarea[name=rollbackPlan]",
    "Boot the previous image from the alternate partition."
  )
  await page.getByRole("button", { name: "Save as draft" }).click()
  await page.waitForURL(/\/tickets\/[0-9a-f-]{36}$/)
  const ticketUrl = page.url()
  await expect(page.locator("body")).toContainText("Draft")
  await transition(page, "Submit for approval")
  await expect(page.locator("body")).toContainText("Awaiting approval")
  // The requester of a change is never offered its approval.
  await expect(
    page.getByRole("button", { name: "Approve", exact: true })
  ).toHaveCount(0)

  const theirs = await browser.newContext()
  const admin = await theirs.newPage()
  await signIn(admin, people.dana.email, SEED_PASSWORD, ACME)
  await admin.goto(ticketUrl)
  await expect(admin.locator("h1")).toContainText(title)
  await transition(admin, "Approve")
  await expect(admin.locator("body")).toContainText("Approved")
  await theirs.close()

  await page.reload()
  await expect(page.locator("body")).toContainText("Approved")
  // Starting is the assignee's (or an admin's): the agent takes the change first.
  await page.getByRole("button", { name: "Take it" }).click()
  await expect(
    page.getByRole("button", { name: "Start work", exact: true })
  ).toBeVisible()
  await transition(page, "Start work")
  await expect(page.locator("body")).toContainText("In progress")
  // The outcome is part of the record, written before the change can be marked implemented.
  await page
    .locator("section", { hasText: "The plan" })
    .getByRole("button", { name: "Edit" })
    .click()
  await page.fill(
    "#detail-outcomeNotes",
    "Flashed in 14 minutes; no failback needed."
  )
  await page
    .locator("[role=dialog]")
    .getByRole("button", { name: "Save" })
    .click()
  await expect(page.locator("[role=dialog]")).toHaveCount(0)
  await transition(page, "Mark implemented")
  await expect(page.locator("body")).toContainText("Implemented")
  await transition(page, "Close")
  await expect(page.locator("body")).toContainText("Closed")
})
