import { expect, type Page, test } from "@playwright/test"

import { signIn } from "./support/session"
import { appOrigin, escapeRegExp, workspaceOrigin } from "./support/stack"

/**
 * Per-tenant single sign-on in a real browser (ADR-0054), against the
 * Keycloak in `docker compose --profile sso` that the seed points Acme at:
 * a person the provider vouches for is provisioned on first sign-in and
 * scoped to Acme; an address the provider has not verified is refused; and
 * once an owner requires SSO, a password-only agent opening Acme is sent to
 * the provider while the owner keeps their own way in.
 *
 * Keycloak's realm (`docker/keycloak/acme-realm.json`) holds kim, lee and
 * nora at `acme.test`, every password `patchgrid-demo`.
 */
const KEYCLOAK = /^http:\/\/localhost:8180\/realms\/acme\//
const ACME = workspaceOrigin("acme")

test.describe.configure({ mode: "serial" })

async function atKeycloak(page: Page, email: string): Promise<void> {
  await page.waitForURL(KEYCLOAK)
  if (await page.locator("#username").isVisible())
    await page.fill("#username", email)
  await page.fill("#password", "patchgrid-demo")
  await page.click("#kc-login")
}

async function ssoFromLogin(page: Page, email: string): Promise<void> {
  await page.goto(`${appOrigin}/login`)
  await page.getByRole("button", { name: "Sign in with SSO" }).click()
  await page.fill("#sso-email", email)
  await page.getByRole("button", { name: "Continue" }).click()
  await atKeycloak(page, email)
}

test("a person the provider vouches for joins Acme on first sign-in, and the session is Acme's alone", async ({
  page,
}) => {
  await ssoFromLogin(page, "kim@acme.test")
  await page.waitForURL(new RegExp(`^${escapeRegExp(ACME)}/`))

  await page.goto(`${appOrigin}/workspaces`)
  await expect(page.getByText("through the single sign-on of")).toBeVisible()
  await expect(page.locator("li", { hasText: "Acme" })).toBeVisible()
  // Account changes are not the provider's to make.
  await page.goto(`${appOrigin}/account`)
  await expect(
    page.getByText("It vouches for that workspace only")
  ).toBeVisible()
})

test("an address the provider has not verified is turned away with the reason", async ({
  page,
}) => {
  await ssoFromLogin(page, "nora@acme.test")
  await page.waitForURL(`${appOrigin}/login?sso=email`)
  await expect(
    page.getByText("didn't vouch for an address at the workspace's domain")
  ).toBeVisible()
})

test("an owner requires SSO; an agent with a password is sent to the provider, the owner is not", async ({
  browser,
}) => {
  const owner = await (await browser.newContext()).newPage()
  await owner.goto(
    `${appOrigin}/login?next=${encodeURIComponent(`${ACME}/settings/sso`)}`
  )
  await owner.fill("#email", "alice@patchgrid.test")
  await owner.fill("#password", "patchgrid-demo")
  await owner.click("button[type=submit]")
  await owner.waitForURL(`${ACME}/settings/sso`)
  const requirement = owner.locator("#requireSso")
  try {
    await requirement.click({ noWaitAfter: true })
    // Whoever controls the requirement controls who gets in: a step-up first.
    const confirm = owner.getByRole("dialog", { name: "Confirm it's you" })
    await confirm.locator("input[type=password]").fill("patchgrid-demo")
    await confirm.getByRole("button", { name: "Confirm" }).click()
    // Acme's seeded people are at patchgrid.test: the provider can never vouch for them, so it asks first.
    await owner
      .getByRole("alertdialog")
      .getByRole("button", { name: "Require it anyway" })
      .click()
    await expect(
      owner.getByText("Single sign-on is now required")
    ).toBeVisible()

    const agent = await (await browser.newContext()).newPage()
    await signIn(agent, "sam@patchgrid.test", "patchgrid-demo")
    await agent.locator('li:has-text("Acme") button:has-text("Open")').click()
    await agent.waitForURL(KEYCLOAK)

    // The owner's own password still opens it: the way back in when the provider is down.
    const again = await (await browser.newContext()).newPage()
    await signIn(again, "alice@patchgrid.test", "patchgrid-demo", "acme")
    await expect(again).toHaveURL(new RegExp(`^${escapeRegExp(ACME)}/`))
  } finally {
    if (await requirement.isChecked()) {
      await requirement.click({ noWaitAfter: true })
      await expect(owner.getByText("no longer required")).toBeVisible()
    }
  }
})
