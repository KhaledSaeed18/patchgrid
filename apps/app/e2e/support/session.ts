import { expect, type APIRequestContext, type Page } from "@playwright/test"

import { apiUrl, appOrigin, workspaceOrigin } from "./stack"

/** The login form on `app.`; with `slug`, the login lands in that workspace. */
export async function signIn(
  page: Page,
  email: string,
  password: string,
  slug?: string
): Promise<void> {
  const next =
    slug === undefined
      ? ""
      : `?next=${encodeURIComponent(`${workspaceOrigin(slug)}/tickets`)}`
  await page.goto(`${appOrigin}/login${next}`)
  await page.fill("#email", email)
  await page.fill("#password", password)
  await page.click("button[type=submit]")
  if (slug === undefined) await page.waitForURL(`${appOrigin}/workspaces`)
  else
    await page.waitForURL(
      new RegExp(`^${workspaceOrigin(slug).replace(/[.]/g, "\\.")}/`)
    )
}

/** From the picker, open one workspace in this tab. */
export async function openFromPicker(
  page: Page,
  name: string,
  slug: string
): Promise<void> {
  await page.goto(`${appOrigin}/workspaces`)
  await page.locator(`li:has-text("${name}") button:has-text("Open")`).click()
  await page.waitForURL(
    new RegExp(`^${workspaceOrigin(slug).replace(/[.]/g, "\\.")}/`)
  )
}

/**
 * Signup is a `202` from a plain form on the marketing site; the interesting
 * part — the emailed link that verifies, signs in and provisions — is driven
 * in the browser. The form itself is one fetch, called here as the site does.
 */
export async function signUp(
  request: APIRequestContext,
  account: { email: string; password: string; name: string }
): Promise<void> {
  const response = await request.post(`${apiUrl}/auth/signup`, {
    data: account,
    headers: { "X-Requested-With": "patchgrid", Origin: appOrigin },
  })
  expect(response.status(), await response.text()).toBe(202)
}

/**
 * A transition button on the ticket page. Some actions ask for a note in a
 * dialog (resolve, cancel, reject…) and some act at once; the helper submits
 * the dialog when one opens and otherwise just waits for the page to settle.
 */
export async function transition(
  page: Page,
  label: string,
  note?: string
): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click()
  const dialog = page.locator("[role=dialog]")
  const opened = await dialog
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(
      () => true,
      () => false
    )
  if (opened) {
    if (note !== undefined) await dialog.locator("textarea").fill(note)
    await dialog.locator(`button[type=submit]:has-text("${label}")`).click()
    await expect(dialog).toHaveCount(0)
  }
  await page.waitForLoadState("networkidle")
}
