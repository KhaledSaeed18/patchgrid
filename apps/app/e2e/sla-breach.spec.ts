import { expect, test } from "@playwright/test"

import { responseDeadlinePassed } from "./support/clock"
import { signIn, transition } from "./support/session"
import {
  ACME,
  people,
  runId,
  SEED_PASSWORD,
  workspaceOrigin,
} from "./support/stack"

/**
 * An SLA breach, without waiting for it: a requester raises an incident,
 * nobody responds, and its response deadline is moved into the past — the
 * suite's test clock — so the real sweep, on its real minute, marks it
 * missed, and the agents' view says so.
 */
test.setTimeout(3 * 60_000)

const title = `Badge reader at the loading dock (${runId})`

test("a missed response deadline is flagged by the sweep, and the ticket says so", async ({
  browser,
  page,
}) => {
  await signIn(page, people.alice.email, SEED_PASSWORD, ACME)

  const theirs = await browser.newContext()
  const requester = await theirs.newPage()
  await signIn(requester, people.rita.email, SEED_PASSWORD, ACME)
  await requester.goto(`${workspaceOrigin(ACME)}/tickets/new`)
  await requester.fill("#ticket-title", title)
  await requester.fill(
    "#ticket-description",
    "Nobody can get in through the dock door."
  )
  // MEDIUM impact × HIGH urgency is HIGH priority (DOMAIN.md §3).
  await requester.check("input[name=impact][value=MEDIUM]")
  await requester.check("input[name=urgency][value=HIGH]")
  await requester.getByRole("button", { name: "Raise ticket" }).click()
  await requester.waitForURL(/\/tickets\/[0-9a-f-]{36}$/)
  const ticketUrl = requester.url()
  await expect(requester.locator("body")).toContainText("High")

  await responseDeadlinePassed(ticketUrl.split("/").pop() ?? "")

  // The sweep looks once a minute. The due badge is the agents' view — a
  // requester is not shown clocks — so the owner watches.
  await page.goto(ticketUrl)
  await expect
    .poll(
      async () => {
        await page.reload()
        return /overdue|missed/i.test(await page.locator("body").innerText())
      },
      { timeout: 2 * 60_000, intervals: [5_000] }
    )
    .toBe(true)

  await transition(
    requester,
    "Cancel ticket",
    "Raised only to watch the clock run out."
  )
  await theirs.close()
})
