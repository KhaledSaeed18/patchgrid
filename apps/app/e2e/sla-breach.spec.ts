import { DEFAULT_SLA_TARGETS } from "@patchgrid/contracts"
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
 * An SLA breach, without waiting a working day: the owner shortens the
 * target for one priority to the minimum, a requester raises an incident at
 * that priority, nobody responds, and the sweep — every minute — marks it
 * missed. Then the policy is put back.
 */
test.describe.configure({ mode: "serial" })
test.setTimeout(5 * 60_000)

const title = `Badge reader at the loading dock (${runId})`
// MEDIUM impact × HIGH urgency is HIGH priority (DOMAIN.md §3).
const usual = DEFAULT_SLA_TARGETS.HIGH

/** The editor speaks durations — `45m`, `4h` — never bare numbers. */
async function setTargets(
  page: import("@playwright/test").Page,
  t: {
    response: number
    responseWarning: number
    resolution: number
    resolutionWarning: number
  }
) {
  await page.fill("#sla-responseTargetMinutes", `${String(t.response)}m`)
  await page.fill(
    "#sla-responseWarningMinutes",
    `${String(t.responseWarning)}m`
  )
  await page.fill("#sla-resolutionTargetMinutes", `${String(t.resolution)}m`)
  await page.fill(
    "#sla-resolutionWarningMinutes",
    `${String(t.resolutionWarning)}m`
  )
  await page.getByRole("button", { name: "Save targets" }).click()
  await expect(page.locator("[role=dialog]")).toHaveCount(0)
}

test("a one-minute response target is missed, and the ticket says so", async ({
  browser,
  page,
}) => {
  await signIn(page, people.alice.email, SEED_PASSWORD, ACME)
  await page.goto(`${workspaceOrigin(ACME)}/settings/sla`)
  const incidents = page.locator("section", { hasText: "Incident" }).first()
  const row = incidents.locator("tr", { hasText: "High" }).first()
  await row.getByRole("button", { name: "Edit" }).click()
  await setTargets(page, {
    response: 2,
    responseWarning: 1,
    resolution: 3,
    resolutionWarning: 2,
  })
  await expect(row).toContainText("2m")

  const theirs = await browser.newContext()
  const requester = await theirs.newPage()
  await signIn(requester, people.rita.email, SEED_PASSWORD, ACME)
  await requester.goto(`${workspaceOrigin(ACME)}/tickets/new`)
  await requester.fill("#ticket-title", title)
  await requester.fill(
    "#ticket-description",
    "Nobody can get in through the dock door."
  )
  await requester.check("input[name=impact][value=MEDIUM]")
  await requester.check("input[name=urgency][value=HIGH]")
  await requester.getByRole("button", { name: "Raise ticket" }).click()
  await requester.waitForURL(/\/tickets\/[0-9a-f-]{36}$/)
  const ticketUrl = requester.url()
  await expect(requester.locator("body")).toContainText("High")

  // The response clock runs from now; the sweep looks once a minute. The due
  // badge is the agents' view — a requester is not shown clocks — so the owner watches.
  await page.goto(ticketUrl)
  await expect
    .poll(
      async () => {
        await page.reload()
        return /overdue|missed/i.test(await page.locator("body").innerText())
      },
      { timeout: 4 * 60_000, intervals: [10_000] }
    )
    .toBe(true)

  // Put the policy back so the seeded workspace reads as it did; close the ticket.
  await transition(
    requester,
    "Cancel ticket",
    "Raised only to watch the clock run out."
  )
  await theirs.close()
  await page.goto(`${workspaceOrigin(ACME)}/settings/sla`)
  await incidents
    .locator("tr", { hasText: "High" })
    .first()
    .getByRole("button", { name: "Edit" })
    .click()
  await setTargets(page, usual)
})
