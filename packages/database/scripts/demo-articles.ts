/**
 * Demo articles for the seed (FEATURES.md M5): fifteen per workspace —
 * mostly published answers to the problems the demo incidents describe, so
 * the new-ticket form has something to suggest, plus internal runbooks and
 * a couple of drafts, so each reader's view differs.
 *
 * Seed-only, and deterministic relative to `now`.
 */
import { type ArticleVisibility, articleSlug } from "@patchgrid/contracts"

import type { PrismaClient } from "../src/index.ts"
import type { SeededOrg } from "../src/lookalikes.ts"

type Author = "agent" | "admin"

/** Title, category (by name), visibility, author, days since the last edit, and the markdown. */
const ARTICLES: [string, string | null, ArticleVisibility, Author, number, string][] = [
  [
    "Outlook keeps asking for your password",
    "Email",
    "PUBLISHED",
    "agent",
    20,
    `Outlook asks again when the sign-in it saved no longer works — usually after a password change.

1. Close Outlook completely, including from the system tray.
2. Open **Credential Manager** and remove every entry that mentions *Outlook* or *Microsoft Office*.
3. Start Outlook and sign in once with your work account.

If it still asks every few minutes, raise a ticket under **Software → Email** and say when it started.`,
  ],
  [
    "Connecting to the VPN from home",
    "VPN",
    "PUBLISHED",
    "agent",
    45,
    `## Before you start

You need the **GlobalProtect** client, installed on every company laptop.

## Connect

1. Open GlobalProtect from the menu bar or system tray.
2. Portal: \`vpn.example.com\`.
3. Sign in with your work account and approve the MFA prompt.

## If it drops every hour

That is the session limit on the old gateway. Choose **Nearest gateway** in the client's settings.`,
  ],
  [
    "Reaching the file share over the VPN",
    "VPN",
    "PUBLISHED",
    "agent",
    30,
    `The finance and shared drives are only reachable through the VPN.

- Connect to the VPN first.
- Open \`\\\\files\\finance\` in File Explorer, not the old \`F:\` mapping.
- If it times out, disconnect and reconnect the VPN once before raising a ticket.`,
  ],
  [
    "Slow Wi-Fi in meeting rooms",
    "Wi-Fi",
    "PUBLISHED",
    "agent",
    12,
    `Meeting rooms share an access point with the corridor, so a full room slows down.

- Use **Corp** rather than **Corp-Guest**; guest traffic is capped.
- For a long video call, use the cable on the table.
- If the whole floor is slow, raise a ticket under **Network → Wi-Fi** with the room name.`,
  ],
  [
    "Guest Wi-Fi for visitors",
    "Wi-Fi",
    "PUBLISHED",
    "admin",
    60,
    `Reception prints the day's guest code each morning. It changes at midnight.

| Network | Who it is for | Password |
| --- | --- | --- |
| Corp | staff devices | your work account |
| Corp-Guest | visitors | the day's code from reception |`,
  ],
  [
    "Resetting your password",
    "Passwords and MFA",
    "PUBLISHED",
    "admin",
    90,
    `Use the **Forgot password** link on the sign-in page. The link in the email lasts **one hour**; ask for a new one if it has expired.

After a reset, sign in again on your phone and laptop — old sessions stop working.`,
  ],
  [
    "The MFA prompt never arrives",
    "Passwords and MFA",
    "PUBLISHED",
    "agent",
    15,
    `1. Open the authenticator app and pull down to refresh.
2. Check the phone's clock is set automatically — codes fail when it drifts.
3. Use **Sign in another way → Enter a code** instead of waiting for the push.

A new phone needs MFA set up again: raise a ticket under **Accounts and access**.`,
  ],
  [
    "Laptop won't wake from sleep",
    "Laptop",
    "PUBLISHED",
    "agent",
    25,
    `Hold the power button for **ten seconds**, wait, then start it normally. Nothing is lost that was saved.

If it happens every morning, a docking-station firmware update usually fixes it — raise a ticket and name the laptop so the team can see its history.`,
  ],
  [
    "Printing to the floor 3 printer",
    "Hardware",
    "PUBLISHED",
    "agent",
    40,
    `The printer is **FL3-MFP**. If it shows *offline* while the panel says *ready*:

1. Remove the printer from your laptop.
2. Add it again from **Settings → Printers → Add**, choosing FL3-MFP.

Paper jams and toner: the facilities desk, not IT.`,
  ],
  [
    "Teams calls with no audio",
    "Software",
    "PUBLISHED",
    "agent",
    8,
    `In the call, open **More → Device settings** and pick the right speaker and microphone — a docking station often adds a second one.

Still silent? Leave the call, quit Teams fully and rejoin.`,
  ],
  [
    "Requesting access to a shared drive",
    "Permissions",
    "PUBLISHED",
    "admin",
    50,
    "Raise a service request under **Accounts and access → Permissions** naming the drive. Access needs your manager's approval; mention who approved it to save a round trip.",
  ],
  [
    "VPN concentrator lease renewal",
    "VPN",
    "INTERNAL",
    "agent",
    5,
    `Runbook for the hourly VPN drops (PRB linked from the incidents).

1. Check the lease expiry on the concentrator dashboard.
2. Renew from **Network → DHCP → Leases**; it takes effect at the next reconnect.
3. Note the renewal on the problem record.

Rollback: the previous lease stays valid for 24 hours.`,
  ],
  [
    "Onboarding a new starter's laptop",
    "Laptop",
    "INTERNAL",
    "admin",
    35,
    `- Take a spare from stock and set it to *In use* against the starter in Assets.
- Enrol it in device management before handing it over.
- Add the starter to their team's groups; licences follow the groups.`,
  ],
  [
    "Handling a reported phishing email",
    "Accounts and access",
    "INTERNAL",
    "admin",
    10,
    `1. Ask the reporter **not** to click anything; get the message as an attachment.
2. Search the mail logs for other recipients and pull the message from every inbox.
3. If anyone entered a password, reset it and revoke their sessions.`,
  ],
  [
    "Draft: replacing the meeting room access points",
    "Wi-Fi",
    "DRAFT",
    "agent",
    2,
    "Notes so far: the U6 Pro in meeting room B saturates at about 25 clients. Quote requested for two more; planning a change once it arrives.",
  ],
]

const DAY = 86_400_000

export async function seedDemoArticles(db: PrismaClient, org: SeededOrg, authors: Record<Author, string>, now = new Date()): Promise<number> {
  const categories = await db.category.findMany({ where: { orgId: org.id }, select: { id: true, name: true } })
  const categoryId = (name: string | null) => (name === null ? null : (categories.find((c) => c.name === name)?.id ?? null))
  for (const [title, category, visibility, author, days, body] of ARTICLES) {
    const at = new Date(now.getTime() - days * DAY)
    await db.knowledgeArticle.create({
      data: {
        orgId: org.id,
        title,
        slug: articleSlug(title),
        body,
        visibility,
        publishedAt: visibility === "PUBLISHED" ? at : null,
        categoryId: categoryId(category),
        authorMembershipId: authors[author],
        // Seeded views, so the numbers on the page look lived in.
        viewCount: visibility === "PUBLISHED" ? 40 + ((title.length * 7) % 160) : 0,
        createdAt: new Date(at.getTime() - 3 * DAY),
        updatedAt: at,
      },
    })
  }
  return ARTICLES.length
}
