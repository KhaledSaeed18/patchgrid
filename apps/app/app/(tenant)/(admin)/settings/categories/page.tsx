import { categorySchema, teamSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import { z } from "zod"

import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

import { CategoryTree } from "./category-tree"

export const metadata: Metadata = { title: "Categories" }

export default async function CategoriesPage() {
  const [categories, teams] = await Promise.all([
    serverApi("/categories?includeInactive=true", {
      schema: z.array(categorySchema),
    }),
    serverApi("/teams", { schema: z.array(teamSchema) }),
  ])
  return (
    <>
      <PageHeader
        title="Categories"
        description="What people pick when they raise a ticket, up to three levels deep. A category can send its tickets straight to a team."
      />
      <CategoryTree initial={categories} teams={teams} />
    </>
  )
}
