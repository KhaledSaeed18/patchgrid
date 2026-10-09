import { categorySchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import { z } from "zod"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { NewTicketForm } from "./new-ticket-form"

export const metadata: Metadata = { title: "Raise a ticket" }

export default async function NewTicketPage() {
  const categories = await serverApi("/categories", {
    schema: z.array(categorySchema),
  })
  return (
    <>
      <PageHeader
        title="Raise a ticket"
        description="Tell the support team what's wrong. You'll be able to follow it and reply from My tickets."
      />
      <NewTicketForm categories={categories} />
    </>
  )
}
