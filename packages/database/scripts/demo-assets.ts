/**
 * Demo assets for the seed (FEATURES.md M5): about twenty per workspace —
 * laptops people hold, the shared kit on the floors, the network and the
 * licences — in every status, with the demo incidents about hardware linked
 * to the asset they are about, so an asset's page has a history to show.
 *
 * Seed-only, and deterministic relative to `now`.
 */
import type { AssetStatus, AssetType } from "@patchgrid/contracts"

import type { PrismaClient } from "../src/index.ts"
import type { SeededOrg } from "../src/lookalikes.ts"

type Holder = "requester" | "agent" | "admin" | null

/** Name, type, status, who holds it, months since purchase, years of warranty. */
const ASSETS: [string, AssetType, AssetStatus, Holder, number, number][] = [
  ["ThinkPad T14 Gen 4", "LAPTOP", "IN_USE", "requester", 14, 3],
  ["MacBook Pro 14", "LAPTOP", "IN_USE", "agent", 8, 3],
  ["Dell Latitude 7440", "LAPTOP", "IN_USE", "admin", 20, 3],
  ["ThinkPad X1 Carbon", "LAPTOP", "IN_REPAIR", null, 30, 3],
  ["ThinkPad T14 Gen 5 (spare)", "LAPTOP", "IN_STOCK", null, 2, 3],
  ["ThinkPad T480", "LAPTOP", "RETIRED", null, 70, 3],
  ["Dell U2723QE — desk 22", "MONITOR", "IN_USE", "requester", 18, 3],
  ["Dell U2723QE — desk 23", "MONITOR", "IN_USE", null, 18, 3],
  ["CalDigit TS4 dock", "OTHER", "IN_USE", "requester", 10, 2],
  ["iPhone 15", "PHONE", "IN_USE", "agent", 12, 1],
  ["Pixel 8", "PHONE", "IN_USE", "requester", 9, 1],
  ["iPad Air — reception", "TABLET", "IN_USE", null, 16, 1],
  ["HP LaserJet M507 — floor 3", "PRINTER", "IN_USE", null, 40, 3],
  ["Epson EB-L630U — boardroom", "OTHER", "IN_USE", null, 26, 5],
  ["FortiGate 60F", "NETWORK", "IN_USE", null, 24, 5],
  ["UniFi U6 Pro — meeting room B", "NETWORK", "IN_USE", null, 22, 2],
  ["UniFi U6 Mesh — warehouse", "NETWORK", "IN_USE", null, 22, 2],
  ["Synology RS1221+ — file share", "SERVER", "IN_USE", null, 36, 3],
  ["Microsoft 365 Business — 25 seats", "SOFTWARE", "IN_USE", null, 6, 1],
  ["Adobe Acrobat Pro — 5 seats", "SOFTWARE", "IN_STOCK", null, 3, 1],
]

/** Which asset a demo incident is about, by the words in its title. */
const ABOUT: [RegExp, string][] = [
  // A title that starts with "Laptop", or mentions a cracked screen anywhere.
  [/(?:^Laptop)|(?:Cracked screen)/, "ThinkPad T14 Gen 4"],
  [/Monitor flickers/, "Dell U2723QE — desk 22"],
  [/Docking station/, "CalDigit TS4 dock"],
  [/Printer on floor 3/, "HP LaserJet M507 — floor 3"],
  [/Projector/, "Epson EB-L630U — boardroom"],
  [/VPN/, "FortiGate 60F"],
  [/meeting room B/, "UniFi U6 Pro — meeting room B"],
  [/warehouse/, "UniFi U6 Mesh — warehouse"],
  [/file share/, "Synology RS1221+ — file share"],
  [/Teams calls|Outlook|Excel/, "Microsoft 365 Business — 25 seats"],
]

const DAY = 86_400_000

export async function seedDemoAssets(
  db: PrismaClient,
  org: SeededOrg,
  people: Record<Exclude<Holder, null>, string>,
  serialPrefix: string,
  now = new Date(),
): Promise<number> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const ids = new Map<string, string>()
  for (const [index, [name, type, status, holder, months, years]] of ASSETS.entries()) {
    const purchased = new Date(today - months * 30 * DAY)
    const asset = await db.asset.create({
      data: {
        orgId: org.id,
        name,
        type,
        status,
        // Licences have no serial; everything else carries one, unique in its workspace.
        serialNumber: type === "SOFTWARE" ? null : `${serialPrefix}-${String(1001 + index)}`,
        ownerMembershipId: holder === null ? null : people[holder],
        purchaseDate: purchased,
        warrantyExpiresAt: new Date(purchased.getTime() + years * 365 * DAY),
        notes: status === "IN_REPAIR" ? "Keyboard replacement booked with the vendor." : null,
      },
      select: { id: true },
    })
    ids.set(name, asset.id)
  }

  const incidents = await db.ticket.findMany({
    where: { orgId: org.id, type: "INCIDENT" },
    select: { id: true, title: true, createdAt: true },
  })
  const links = incidents.flatMap((ticket) => {
    const assetId = ids.get(ABOUT.find(([pattern]) => pattern.test(ticket.title))?.[1] ?? "")
    return assetId === undefined ? [] : [{ orgId: org.id, ticketId: ticket.id, assetId, createdAt: ticket.createdAt }]
  })
  await db.ticketAsset.createMany({ data: links })
  return ASSETS.length
}
