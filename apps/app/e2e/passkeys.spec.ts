import { expect, test } from "@playwright/test"

import { linkInMailTo } from "./support/mailpit"
import { signUp } from "./support/session"
import {
  appOrigin,
  chromiumArgs,
  escapeRegExp,
  runId,
  workspaceOrigin,
} from "./support/stack"

/**
 * Passkeys in a real browser (ADR-0053), with Chromium's virtual
 * authenticator standing in for a fingerprint reader: one added from the
 * account page against the password, a sign-in with nothing typed, a step-up
 * proved by it, and its removal proved by itself.
 *
 * WebAuthn exists only in secure contexts, and the development hosts are
 * plain http, so Chromium is told to treat the two this spec uses as secure.
 * Only full Chromium honours that; the default headless shell does not.
 * A fresh account is used throughout: a seeded person holding a passkey would
 * change every other spec's password login.
 */
const slug = `e2e-pk-${runId}`
const owner = {
  email: `passkey-${runId}@patchgrid.test`,
  password: "correct horse battery staple",
  name: "Pat Passkey",
}

// The headless shell ignores the secure-origin flag; full Chromium in new headless mode honours it.
test.use({
  channel: "chromium",
  launchOptions: {
    args: [
      ...chromiumArgs,
      `--unsafely-treat-insecure-origin-as-secure=${appOrigin},${workspaceOrigin(slug)}`,
    ],
  },
})
test.describe.configure({ mode: "serial" })

test("a passkey signs in alone, proves a step-up, and proves its own removal", async ({
  page,
  request,
}) => {
  // A platform authenticator with a verified user, answering every prompt at once.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    }
  )

  // A new owner with a workspace of their own.
  const since = new Date()
  await signUp(request, owner)
  await page.goto(
    await linkInMailTo(
      request,
      owner.email,
      /verify/i,
      /https?:\/\/\S+\/verify-email\?token=[A-Za-z0-9_-]+/,
      since
    )
  )
  await page.waitForURL(`${appOrigin}/new`)
  await page.fill("#name", `Passkeys ${runId}`)
  await page.fill("#slug", slug)
  await page.click("button[type=submit]")
  await page.waitForURL(new RegExp(`^${escapeRegExp(workspaceOrigin(slug))}/`))

  // Added from the account page: the password is the proof, because there is no factor yet.
  await page.goto(`${appOrigin}/account/security`)
  await page.getByRole("button", { name: "Add a passkey" }).click()
  await page.fill("#passkey-label", "Virtual key")
  await page.getByRole("button", { name: "Continue" }).click()
  await page.fill("#holder-password", owner.password)
  await page.getByRole("button", { name: "Continue" }).click()
  // The first factor brings the recovery codes, once.
  await expect(page.getByRole("list", { name: "Recovery codes" })).toBeVisible()
  await page.getByRole("button", { name: "I've saved them" }).click()
  await expect(page.locator("body")).toContainText("Virtual key")
  const held = await cdp.send("WebAuthn.getCredentials", { authenticatorId })
  expect(held.credentials).toHaveLength(1)
  expect(held.credentials[0]?.isResidentCredential).toBe(true)

  // Signed out, then back in with nothing typed — straight into the workspace the login was for.
  await page.context().clearCookies()
  await page.goto(
    `${appOrigin}/login?next=${encodeURIComponent(`${workspaceOrigin(slug)}/settings/api-tokens`)}`
  )
  await page.getByRole("button", { name: "Sign in with a passkey" }).click()
  await page.waitForURL(`${workspaceOrigin(slug)}/settings/api-tokens`)

  // Minting a token is irreversible: the step-up asks for the passkey, not the password.
  await page.getByRole("button", { name: "Create token" }).click()
  await page.fill("#token-name", `Zabbix ${runId}`)
  await page
    .locator("[role=dialog]")
    .getByRole("button", { name: "Create token" })
    .click()
  const stepUp = page.locator("[role=dialog]", { hasText: "Confirm it's you" })
  await expect(stepUp).toBeVisible()
  await expect(stepUp.locator("#holder-password")).toHaveCount(0)
  await stepUp.getByRole("button", { name: "Use a passkey" }).click()
  await expect(stepUp).toHaveCount(0)
  await expect(page.locator("body")).toContainText(`Zabbix ${runId}`)

  // Removed, proved by itself; it signs no one in afterwards.
  await page.goto(`${appOrigin}/account/security`)
  await page.getByRole("button", { name: "Remove" }).click()
  await page
    .locator("[role=dialog]")
    .getByRole("button", { name: "Use a passkey" })
    .click()
  await expect(page.locator("body")).toContainText("Passkey removed.")
  await expect(page.locator("body")).not.toContainText("Virtual key")
})
