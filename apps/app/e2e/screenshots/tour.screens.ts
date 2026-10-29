import { spawnSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { mkdirSync, readdirSync } from "node:fs"
import path from "node:path"

import {
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test"

import { openFromPicker, signIn } from "../support/session"
import {
  apiOrigin,
  appOrigin,
  MAILPIT_URL,
  ROOT_DOMAIN,
  workspaceOrigin,
} from "../support/stack"

/**
 * The README's tour, taken from the seeded demo (`playwright.screenshots.config.ts`).
 * Read-only apart from the operator's first sign-in, which enrols a factor:
 * a second run needs a fresh seed.
 */
const OUT = path.join(import.meta.dirname, "../../../../docs/screenshots")
const PASSWORD = "patchgrid-demo"
const wwwOrigin = `http://${ROOT_DOMAIN}:3000`
const adminOrigin = appOrigin.replace("//app.", "//admin.")
/** The observability profile's Grafana (docker-compose.yml). */
const GRAFANA_URL = "http://localhost:3100"

for (const dir of ["light", "dark"])
  mkdirSync(path.join(OUT, dir), { recursive: true })

/** The dev-server badge and the error overlay are not part of the product. */
const HIDE_DEV_CHROME = `
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style")
    style.textContent = "nextjs-portal { display: none !important; }"
    document.head.append(style)
  })
`

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

const shot = (page: Page, file: string) =>
  page.screenshot({ path: file, animations: "disabled", caret: "hide" })

/** A page that follows the theme: taken light, then dark, from one navigation. */
async function themed(page: Page, name: string): Promise<void> {
  await settle(page)
  await shot(page, path.join(OUT, "light", `${name}.png`))
  await page.emulateMedia({ colorScheme: "dark" })
  await page.waitForFunction(() =>
    document.documentElement.classList.contains("dark")
  )
  await settle(page)
  await shot(page, path.join(OUT, "dark", `${name}.png`))
  await page.emulateMedia({ colorScheme: "light" })
  await page.waitForFunction(
    () => !document.documentElement.classList.contains("dark")
  )
}

/** A page with one look: the marketing site, the API reference, Grafana, Mailpit. */
async function plain(page: Page, name: string): Promise<void> {
  await settle(page)
  await shot(page, path.join(OUT, `${name}.png`))
}

async function visit(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url)
  await themed(page, name)
}

async function browse(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  await context.addInitScript(HIDE_DEV_CHROME)
  return context.newPage()
}

async function as(
  browser: Browser,
  email: string,
  slug?: string
): Promise<Page> {
  const page = await browse(browser)
  await signIn(page, email, PASSWORD, slug)
  return page
}

/** Open the ticket a row names, from a list already on screen. */
async function openRow(page: Page, rows: Locator): Promise<string> {
  await rows.first().locator("a[href^='/tickets/']").first().click()
  await page.waitForURL(/\/tickets\/[0-9a-f-]{36}$/)
  return new URL(page.url()).pathname
}

/** RFC 6238, as the operator's authenticator app would compute it. */
function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  const bits = [...secret.replace(/=+$/, "").toUpperCase()]
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0"))
    .join("")
  const key = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2))
  )
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const mac = createHmac("sha1", key).update(counter).digest()
  const offset = (mac.at(-1) ?? 0) & 0xf
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)
    .toString()
    .padStart(6, "0")
}

test.describe.configure({ mode: "serial" })

let incidentPath = ""

test("the marketing site", async ({ browser }) => {
  const page = await browse(browser)
  await page.goto(wwwOrigin)
  await plain(page, "www-home")
  await page.goto(`${wwwOrigin}/pricing`)
  await plain(page, "www-pricing")
  await page.goto(`${wwwOrigin}/docs/priority-and-slas`)
  await plain(page, "www-docs")
  await page.goto(`${wwwOrigin}/blog/foreign-keys-that-leak`)
  await plain(page, "www-blog")
  await page.goto(`${wwwOrigin}/signup`)
  await plain(page, "www-signup")
})

test("signing in, and one person in two workspaces", async ({ browser }) => {
  const page = await browse(browser)
  await visit(page, `${appOrigin}/login`, "login")

  // A session is per workspace: each is opened from the picker before its queue.
  const dana = await as(browser, "dana@patchgrid.test")
  await themed(dana, "workspaces")
  for (const [name, slug] of [
    ["Acme", "acme"],
    ["Globex", "globex"],
  ] as const) {
    await openFromPicker(dana, name, slug)
    await visit(
      dana,
      `${workspaceOrigin(slug)}/queues?view=open`,
      `dana-${slug}`
    )
  }
})

test("an agent's day", async ({ browser }) => {
  const page = await as(browser, "sam@patchgrid.test", "acme")
  const acme = workspaceOrigin("acme")

  await visit(page, `${acme}/queues?view=open`, "queue")

  // Bulk actions: a few rows picked, the bar that acts on them.
  const boxes = page.locator("tbody input[type=checkbox]")
  for (const i of [1, 2, 4]) await boxes.nth(i).check()
  await themed(page, "queue-bulk")

  await page.goto(`${acme}/queues?view=open&q=INC-000001`)
  incidentPath = await openRow(
    page,
    page.locator("tr", { hasText: "INC-000001" })
  )
  await themed(page, "incident")

  await page.goto(`${acme}/queues?view=open&q=PRB-000001`)
  await openRow(page, page.locator("tr", { hasText: "PRB-000001" }))
  await themed(page, "problem")

  await visit(page, `${acme}/queues?view=approvals`, "approvals")
  await openRow(page, page.locator("tbody tr"))
  await themed(page, "change")

  await visit(page, `${acme}/notifications`, "notifications")

  await visit(page, `${acme}/knowledge`, "knowledge")
  await page
    .getByRole("link", { name: "Connecting to the VPN", exact: true })
    .click()
  await page.waitForURL(/\/knowledge\/[^/]+$/)
  await themed(page, "article")

  await visit(page, `${acme}/assets`, "assets")
  await page.locator("a[href^='/assets/']").first().click()
  await page.waitForURL(/\/assets\/[0-9a-f-]{36}$/)
  await themed(page, "asset")
})

test("a requester's view", async ({ browser }) => {
  const page = await as(browser, "rita@patchgrid.test", "acme")
  const acme = workspaceOrigin("acme")

  await visit(page, `${acme}/tickets`, "portal")

  // No priority field: what it affects and how urgent it is decide it.
  await page.goto(`${acme}/tickets/new`)
  await page.fill("#ticket-title", "VPN connection drops")
  await expect(page.getByLabel("Articles that might help")).toBeVisible()
  await themed(page, "new-ticket")

  // The same incident the agent saw, without the internal note.
  expect(incidentPath).not.toBe("")
  await visit(page, `${acme}${incidentPath}`, "requester-incident")
})

test("the owner's settings", async ({ browser }) => {
  const page = await as(browser, "alice@patchgrid.test", "acme")
  const acme = workspaceOrigin("acme")

  for (const [route, name] of [
    ["/reports", "reports"],
    ["/settings", "settings"],
    ["/settings/members", "members"],
    ["/settings/teams", "teams"],
    ["/settings/sla", "sla"],
    ["/settings/categories", "categories"],
    ["/settings/inbound", "inbound"],
    ["/settings/audit", "audit"],
    ["/settings/api-tokens", "api-tokens"],
    ["/settings/events", "events"],
    ["/settings/sso", "sso"],
    ["/settings/support", "support"],
    ["/settings/webhooks", "webhooks"],
  ] as const)
    await visit(page, `${acme}${route}`, name)

  await page.locator("a[href^='/settings/webhooks/']").first().click()
  await page.waitForURL(/\/settings\/webhooks\/[0-9a-f-]{36}$/)
  await themed(page, "webhook")

  await visit(page, `${appOrigin}/account/security`, "account-security")
})

test("the operators' back-office", async ({ browser }) => {
  const page = await browse(browser)
  await page.goto(`${adminOrigin}/login`)
  await page.fill("#email", "dana@patchgrid.test")
  await page.fill("#password", PASSWORD)
  const enrolment = page.waitForResponse((r) =>
    r.url().endsWith("/auth/mfa/enrol")
  )
  await page.click("button[type=submit]")
  const { secret } = (await (await enrolment).json()) as { secret: string }
  await expect(page.locator("#code")).toBeVisible()
  await themed(page, "backoffice-mfa")

  await page.fill("#code", totp(secret))
  await page.click("button[type=submit]")
  await page.getByRole("button", { name: /saved|continue|done/i }).click()
  await page.waitForURL(`${adminOrigin}/orgs`)
  await themed(page, "backoffice")

  await page.locator("a[href^='/orgs/']", { hasText: "Acme" }).first().click()
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/)
  await themed(page, "backoffice-org")
})

test("around the product", async ({ browser, request }) => {
  const page = await browse(browser)

  await page.goto(`${apiOrigin}/api/docs`)
  await page.locator(".swagger-ui .opblock").first().waitFor()
  await plain(page, "api-docs")

  const list = await request.get(`${MAILPIT_URL}/api/v1/messages?limit=1`)
  const { messages } = (await list.json()) as { messages: { ID: string }[] }
  if (messages[0] !== undefined) {
    await page.goto(`${MAILPIT_URL}/view/${messages[0].ID}`)
    await plain(page, "email")
  }

  const grafana = await request
    .get(`${GRAFANA_URL}/api/health`)
    .catch(() => null)
  if (grafana?.ok() === true) {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.goto(
      `${GRAFANA_URL}/d/patchgrid-tenants?orgId=1&from=now-8m&to=now&theme=dark&kiosk`
    )
    await page.locator(".react-grid-item").first().waitFor()
    await plain(page, "grafana")
  }
})

/** Retina PNGs are large; pngquant brings them to a size a repository can carry. */
test.afterAll(() => {
  const files = ["", "light", "dark"].flatMap((dir) =>
    readdirSync(path.join(OUT, dir))
      .filter((name) => name.endsWith(".png"))
      .map((name) => path.join(OUT, dir, name))
  )
  // 98 and 99 are pngquant declining a file it cannot shrink: not a failure.
  const run = spawnSync("pngquant", [
    "--force",
    "--skip-if-larger",
    "--quality=75-95",
    "--ext=.png",
    ...files,
  ])
  if (run.error !== undefined)
    console.warn("pngquant is not installed: the screenshots are uncompressed")
})
