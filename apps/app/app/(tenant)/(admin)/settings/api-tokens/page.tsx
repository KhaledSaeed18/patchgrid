import { apiTokenSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import { z } from "zod"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { ApiTokens } from "./api-tokens"

export const metadata: Metadata = { title: "API tokens" }

export default async function ApiTokensPage() {
  const tokens = await serverApi("/org/api-tokens", {
    schema: z.array(apiTokenSchema),
  })
  return (
    <>
      <PageHeader
        title="API tokens"
        description="Let a monitoring system or a script raise and read tickets here. Each token acts as its own service account, can do only what its role and scopes allow, and never manages members, settings or other tokens."
      />
      <ApiTokens initial={tokens} />
    </>
  )
}
