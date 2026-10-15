import { expect, test } from "@playwright/test"

import { openFromPicker, signIn } from "./support/session"
import {
  ACME,
  apiUrl,
  appOrigin,
  GLOBEX,
  people,
  runId,
  SEED_PASSWORD,
  escapeRegExp,
  workspaceOrigin,
} from "./support/stack"

/**
 * The negatives (FEATURES.md M9, ADR-0024): what per-tenant cookies and
 * server-side authorization are for, exercised from a real browser rather
 * than a mocked request. The happy paths are the easy part.
 */

test("cross-tenant: a session for Acme reaches nothing of Globex, in the page or over fetch", async ({
  page,
}) => {
  await signIn(page, people.alice.email, SEED_PASSWORD, ACME)
  await expect(page.locator("body")).toContainText("Acme")

  // The browser holds Alice's Acme pair and her pg_id. Globex has no cookie of its own and sends her away.
  await page.goto(`${workspaceOrigin(GLOBEX)}/tickets`)
  await page.waitForURL(new RegExp(`^${escapeRegExp(appOrigin)}/`))
  expect(new URL(page.url()).host).toBe(new URL(appOrigin).host)

  // The same cookie jar, asked as Globex and as Acme: the per-tenant cookie is the whole difference.
  const me = async (origin: string): Promise<number> =>
    (
      await page.request.get(`${apiUrl}/me`, { headers: { Origin: origin } })
    ).status()
  expect(await me(workspaceOrigin(GLOBEX))).toBe(401)
  expect(await me(workspaceOrigin(ACME))).toBe(200)

  // Alice is not a member of Globex: the picker does not list it, and opening it by hand is refused.
  await page.goto(`${appOrigin}/workspaces`)
  await expect(page.locator("li", { hasText: "Globex" })).toHaveCount(0)
  const opened = await page.evaluate(
    async (url) =>
      (
        await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "patchgrid",
          },
          body: JSON.stringify({ slug: "globex" }),
        })
      ).status,
    `${apiUrl}/auth/sessions`
  )
  expect(opened).toBe(403)
})

test("role escalation: an agent cannot reach admin pages, promote anyone, or promote themselves", async ({
  page,
}) => {
  await signIn(page, people.sam.email, SEED_PASSWORD, ACME)
  await page.goto(`${workspaceOrigin(ACME)}/settings/members`)
  await expect(page.locator("h1")).toContainText("Nothing here")
  await page.goto(`${workspaceOrigin(ACME)}/settings/api-tokens`)
  await expect(page.locator("h1")).toContainText("Nothing here")

  await page.goto(`${workspaceOrigin(ACME)}/tickets`)
  const status = (path: string, method: string, body?: unknown) =>
    page.evaluate(
      async ([url, m, b]) =>
        (
          await fetch(url, {
            method: m,
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "X-Requested-With": "patchgrid",
            },
            ...(b === undefined ? {} : { body: JSON.stringify(b) }),
          })
        ).status,
      [`${apiUrl}${path}`, method, body] as const
    )
  const me = await page.evaluate(
    async (url) =>
      (await (await fetch(url, { credentials: "include" })).json()) as {
        membership: { id: string }
      },
    `${apiUrl}/me`
  )
  // Member admin is an admin's; reading the member list is not (RBAC.md §6), so the answer is 403, not 404.
  expect(
    await status(`/members/${me.membership.id}/role`, "PATCH", {
      role: "ADMIN",
    })
  ).toBe(403)
  expect(
    await status(`/members/${me.membership.id}/role`, "PATCH", {
      role: "OWNER",
    })
  ).toBe(403)
  expect(
    await status("/invitations", "POST", {
      email: `nobody-${runId}@patchgrid.test`,
      role: "ADMIN",
    })
  ).toBe(403)
  expect(
    await status("/org/api-tokens", "POST", {
      name: "x",
      role: "AGENT",
      scopes: ["tickets:read"],
      expiresInDays: null,
    })
  ).toBe(403)
  // The role on the server is unchanged.
  const after = await page.evaluate(
    async (url) =>
      (await (await fetch(url, { credentials: "include" })).json()) as {
        membership: { role: string }
      },
    `${apiUrl}/me`
  )
  expect(after.membership.role).toBe("AGENT")
})

test("two tabs, two tenants: both stay usable, each with its own session", async ({
  page,
  context,
}) => {
  await signIn(page, people.dana.email, SEED_PASSWORD)
  await openFromPicker(page, "Acme", ACME)
  const other = await context.newPage()
  await openFromPicker(other, "Globex", GLOBEX)

  // Each tab names its own workspace, and keeps doing so after the other acted.
  await page.goto(`${workspaceOrigin(ACME)}/tickets/new`)
  await page.fill("#ticket-title", `Acme-side note (${runId})`)
  await page.fill("#ticket-description", "Raised from tab one.")
  await page.getByRole("button", { name: "Raise ticket" }).click()
  await page.waitForURL(/\/tickets\/[0-9a-f-]{36}$/)

  await other.goto(`${workspaceOrigin(GLOBEX)}/tickets/new`)
  await other.fill("#ticket-title", `Globex-side note (${runId})`)
  await other.fill("#ticket-description", "Raised from tab two.")
  await other.getByRole("button", { name: "Raise ticket" }).click()
  await other.waitForURL(/\/tickets\/[0-9a-f-]{36}$/)

  await page.reload()
  await expect(page.locator("body")).toContainText("Acme")
  await expect(page.locator("body")).toContainText(`Acme-side note (${runId})`)
  await other.reload()
  await expect(other.locator("body")).toContainText("Globex")
  await expect(other.locator("body")).toContainText(
    `Globex-side note (${runId})`
  )

  // Neither tab's ticket leaks into the other's list.
  await page.goto(`${workspaceOrigin(ACME)}/tickets`)
  await expect(page.locator("body")).not.toContainText(
    `Globex-side note (${runId})`
  )
  await other.goto(`${workspaceOrigin(GLOBEX)}/tickets`)
  await expect(other.locator("body")).not.toContainText(
    `Acme-side note (${runId})`
  )
})
