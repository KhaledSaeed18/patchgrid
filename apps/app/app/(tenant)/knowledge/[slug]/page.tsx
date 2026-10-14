import { articleSchema, articleSlugSchema } from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { buttonVariants } from "@patchgrid/ui/components/button"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Markdown } from "@/components/markdown"
import { PageHeader } from "@/components/page-header"
import { RelativeTime } from "@/components/tickets/relative-time"
import { serverApi } from "@/lib/api/server"
import { ARTICLE_VISIBILITY_LABEL } from "@/lib/labels"

export const metadata: Metadata = { title: "Article" }

/** An article, as its reader reads it — one view counted. Editing is a page of its own. */
export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  if (!articleSlugSchema.safeParse(slug).success) notFound()
  const article = await serverApi(`/articles/by-slug/${slug}`, {
    schema: articleSchema,
  })
  return (
    <>
      <PageHeader
        title={article.title}
        description={
          <>
            <Link href="/knowledge" className="hover:underline">
              Knowledge
            </Link>
            {article.category !== null && <> · {article.category.name}</>}
            {" · "}Updated <RelativeTime at={article.updatedAt} /> by{" "}
            {article.author.displayName}
          </>
        }
        action={
          article.capabilities.canEdit ? (
            <Link
              href={`/knowledge/edit/${article.id}`}
              className={buttonVariants({ variant: "outline" })}
            >
              Edit
            </Link>
          ) : undefined
        }
      />
      <article className="max-w-3xl px-6 py-8 md:px-10">
        {article.visibility !== "PUBLISHED" && (
          <Badge variant="outline" className="mb-4">
            {ARTICLE_VISIBILITY_LABEL[article.visibility]}
          </Badge>
        )}
        <Markdown>{article.body}</Markdown>
      </article>
    </>
  )
}
