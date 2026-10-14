import { categorySchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import { z } from "zod"

import { ArticleEditor } from "@/components/knowledge/article-editor"
import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

export const metadata: Metadata = { title: "Write an article" }

/** A new article starts as a draft unless its author chooses otherwise. */
export default async function NewArticlePage() {
  const categories = await serverApi("/categories", {
    schema: z.array(categorySchema),
  })
  return (
    <>
      <PageHeader
        title="Write an article"
        description="A draft until you choose who can read it. Requesters only ever see published articles."
      />
      <ArticleEditor categories={categories} />
    </>
  )
}
