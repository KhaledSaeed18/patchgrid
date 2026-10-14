import { articleSchema, categorySchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { z } from "zod"

import { ArticleEditor } from "@/components/knowledge/article-editor"
import { PageHeader } from "@/components/page-header"
import { serverApi } from "@/lib/api/server"

export const metadata: Metadata = { title: "Edit article" }

const ID = z.uuid()

/** Loaded by id, so opening the editor counts no view; saved against the version it opened at. */
export default async function EditArticlePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!ID.safeParse(id).success) notFound()
  const [article, categories] = await Promise.all([
    serverApi(`/articles/${id}`, { schema: articleSchema }),
    serverApi("/categories", { schema: z.array(categorySchema) }),
  ])
  if (!article.capabilities.canEdit) notFound()
  return (
    <>
      <PageHeader
        title={`Edit “${article.title}”`}
        description={
          <Link href={`/knowledge/${article.slug}`} className="hover:underline">
            Back to the article
          </Link>
        }
      />
      <ArticleEditor article={article} categories={categories} />
    </>
  )
}
