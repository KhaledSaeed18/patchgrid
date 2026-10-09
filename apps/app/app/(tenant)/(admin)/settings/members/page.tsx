import {
  invitationSchema,
  memberPageSchema,
  teamSchema,
} from "@patchgrid/contracts"
import type { Metadata } from "next"
import { z } from "zod"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { MembersAdmin } from "./members-admin"

export const metadata: Metadata = { title: "Members" }

export default async function MembersPage() {
  const [members, invitations, teams] = await Promise.all([
    serverApi("/members?limit=100", { schema: memberPageSchema }),
    serverApi("/invitations", { schema: z.array(invitationSchema) }),
    serverApi("/teams", { schema: z.array(teamSchema) }),
  ])
  return (
    <>
      <PageHeader
        title="Members"
        description="Who can use this workspace, and as what. Agents and above take a seat on the plan; requesters don't."
      />
      <MembersAdmin
        initialMembers={members}
        initialInvitations={invitations}
        teams={teams}
      />
    </>
  )
}
