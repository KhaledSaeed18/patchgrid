import { teamSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import { z } from "zod"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { TeamList } from "./team-list"

export const metadata: Metadata = { title: "Teams" }

export default async function TeamsPage() {
  const teams = await serverApi("/teams", { schema: z.array(teamSchema) })
  return (
    <>
      <PageHeader
        title="Teams"
        description="Groups of agents that tickets are routed to. A team's lead can add and remove its members."
      />
      <TeamList initial={teams} />
    </>
  )
}
