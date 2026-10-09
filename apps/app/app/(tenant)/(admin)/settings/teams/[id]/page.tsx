import {
  idSchema,
  memberPageSchema,
  teamDetailSchema,
} from "@patchgrid/contracts"
import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { serverApi } from "@/lib/api/server"

import { TeamDetailView } from "./team-detail"

export const metadata: Metadata = { title: "Team" }

export default async function TeamPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!idSchema.safeParse(id).success) notFound()
  const [team, members] = await Promise.all([
    serverApi(`/teams/${id}`, { schema: teamDetailSchema }),
    serverApi("/members?limit=100", { schema: memberPageSchema }),
  ])
  // Who could be added: active agents and above not already in the team.
  const inTeam = new Set(team.members.map((m) => m.membershipId))
  const candidates = members.items.filter(
    (m) => m.status === "ACTIVE" && m.role !== "REQUESTER" && !inTeam.has(m.id)
  )
  return <TeamDetailView initial={team} candidates={candidates} />
}
