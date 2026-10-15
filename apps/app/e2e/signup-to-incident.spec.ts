import { expect, test } from "@playwright/test"

import { linkInMailTo } from "./support/mailpit"
import { signUp, transition } from "./support/session"
import { appOrigin, runId, workspaceOrigin } from "./support/stack"

/**
 * The first day of a new customer, in a real browser: signup, the emailed
 * verification that signs them in, a workspace provisioned on its own
 * subdomain, an agent invited and joining with a brand-new account, and one
 * incident worked from raised to closed by the two of them.
 */
test.describe.configure({ mode: "serial" })

const slug = `e2e-${runId}`
const owner = {
  email: `owner-${runId}@patchgrid.test`,
  password: "correct horse battery staple",
  name: "Olive Owner",
}
const agent = {
  email: `agent-${runId}@patchgrid.test`,
  password: "another horse battery staple",
  name: "Avery Agent",
}
const title = `Projector in room 4 is dead (${runId})`

test("signup → verification → a provisioned workspace", async ({
  page,
  request,
}) => {
  const since = new Date()
  await signUp(request, owner)
  const verifyUrl = await linkInMailTo(
    request,
    owner.email,
    /verify/i,
    /https?:\/\/\S+\/verify-email\?token=[A-Za-z0-9_-]+/,
    since
  )
  await page.goto(verifyUrl)
  // A verified account with no workspace is sent to make one.
  await page.waitForURL(`${appOrigin}/new`)
  await page.fill("#name", `E2E ${runId}`)
  await page.fill("#slug", slug)
  await page.click("button[type=submit]")
  await page.waitForURL(
    new RegExp(`^${workspaceOrigin(slug).replace(/[.]/g, "\\.")}/`)
  )
  await expect(page.locator("body")).toContainText(`E2E ${runId}`)
})

test("the owner invites an agent, who joins with a new account", async ({
  browser,
  page,
  request,
}) => {
  // A login names the workspace it is for; its pair is minted in the same answer.
  await page.goto(
    `${appOrigin}/login?next=${encodeURIComponent(`${workspaceOrigin(slug)}/settings/members`)}`
  )
  await page.fill("#email", owner.email)
  await page.fill("#password", owner.password)
  await page.click("button[type=submit]")
  await page.waitForURL(`${workspaceOrigin(slug)}/settings/members`)
  await page.getByRole("button", { name: "Invite people" }).click()
  await page.fill("#invite-email", agent.email)
  await page.selectOption("#invite-role", "AGENT")
  const since = new Date()
  await page.getByRole("button", { name: "Send invitation" }).click()
  await expect(page.locator("body")).toContainText(agent.email)

  const acceptUrl = await linkInMailTo(
    request,
    agent.email,
    /invit/i,
    /https?:\/\/\S+\/invite\?token=[A-Za-z0-9_%.-]+/,
    since
  )
  const theirs = await browser.newContext()
  const agentPage = await theirs.newPage()
  await agentPage.goto(acceptUrl)
  await agentPage.fill("#name", agent.name)
  await agentPage.fill("#password", agent.password)
  await agentPage
    .getByRole("button", { name: "Create account and join" })
    .click()
  await agentPage.waitForURL(
    new RegExp(`^${workspaceOrigin(slug).replace(/[.]/g, "\\.")}/`)
  )
  await expect(agentPage.locator("body")).toContainText(agent.name)
  await theirs.close()
})

test("an incident is raised, worked and closed between them", async ({
  browser,
  page,
}) => {
  await page.goto(
    `${appOrigin}/login?next=${encodeURIComponent(`${workspaceOrigin(slug)}/tickets/new`)}`
  )
  await page.fill("#email", owner.email)
  await page.fill("#password", owner.password)
  await page.click("button[type=submit]")
  await page.waitForURL(`${workspaceOrigin(slug)}/tickets/new`)
  await page.fill("#ticket-title", title)
  await page.fill(
    "#ticket-description",
    "No signal on the wall display since this morning."
  )
  await page.check("input[name=impact][value=MEDIUM]")
  await page.check("input[name=urgency][value=HIGH]")
  await page.getByRole("button", { name: "Raise ticket" }).click()
  await page.waitForURL(/\/tickets\/[0-9a-f-]{36}$/)
  await expect(page.locator("h1")).toContainText(title)
  await expect(page.locator("body")).toContainText("New")
  // An agent's "My tickets" lists their own; the one just raised is reached by its address, as from a queue or a mail.
  const ticketUrl = page.url()

  const theirs = await browser.newContext()
  const agentPage = await theirs.newPage()
  await agentPage.goto(
    `${appOrigin}/login?next=${encodeURIComponent(`${workspaceOrigin(slug)}/tickets`)}`
  )
  await agentPage.fill("#email", agent.email)
  await agentPage.fill("#password", agent.password)
  await agentPage.click("button[type=submit]")
  await agentPage.waitForURL(`${workspaceOrigin(slug)}/tickets`)
  await agentPage.goto(ticketUrl)
  await expect(agentPage.locator("h1")).toContainText(title)
  await transition(agentPage, "Start work")
  await expect(agentPage.locator("body")).toContainText("In progress")
  await transition(
    agentPage,
    "Resolve",
    "Replaced the HDMI cable behind the display."
  )
  await expect(agentPage.locator("body")).toContainText("Resolved")
  await theirs.close()

  // The requester sees the note and closes it themselves.
  await page.reload()
  await expect(page.locator("body")).toContainText("Replaced the HDMI cable")
  await transition(page, "Close")
  await expect(page.locator("body")).toContainText("Closed")
})
