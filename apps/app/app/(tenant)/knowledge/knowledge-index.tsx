"use client"

import {
  type ArticlePage,
  articlePageSchema,
  type ArticleSummary,
  type ArticleVisibility,
  articleVisibilitySchema,
} from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button, buttonVariants } from "@patchgrid/ui/components/button"
import { Input } from "@patchgrid/ui/components/input"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useInfiniteQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { NativeSelect } from "@/components/native-select"
import { PageHeader } from "@/components/page-header"
import { useTenant } from "@/components/tenant-provider"
import { RelativeTime } from "@/components/tickets/relative-time"
import { clientApi } from "@/lib/api/client"
import { ARTICLE_VISIBILITY_LABEL } from "@/lib/labels"

type Props =
  | { q: string; visibility: undefined; found: ArticleSummary[] }
  | {
      q: ""
      visibility: ArticleVisibility | undefined
      first: ArticlePage
      query: string
    }

export function KnowledgeIndex(props: Props) {
  const { holds } = useTenant()
  const router = useRouter()
  const agent = holds("kb:read_internal")
  const go = (next: {
    q?: string
    visibility?: ArticleVisibility | undefined
  }) => {
    const params = new URLSearchParams()
    const q = next.q ?? ""
    if (q !== "") params.set("q", q)
    else if (next.visibility !== undefined)
      params.set("visibility", next.visibility)
    const search = params.toString()
    router.push(search === "" ? "/knowledge" : `/knowledge?${search}`)
  }

  return (
    <>
      <PageHeader
        title="Knowledge"
        description={
          agent
            ? "Answers for requesters and runbooks for the team, in one place."
            : "Answers to common questions — worth a look before you raise a ticket."
        }
        action={
          holds("kb:write") ? (
            <Link href="/knowledge/new" className={buttonVariants()}>
              Write an article
            </Link>
          ) : undefined
        }
      />
      <div className="px-6 py-6 md:px-10">
        <div className="flex flex-wrap gap-3">
          <form
            role="search"
            className="w-full max-w-md"
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              go({ q: String(data.get("q") ?? "").trim() })
            }}
          >
            <Input
              key={props.q}
              name="q"
              type="search"
              defaultValue={props.q}
              placeholder="Search the knowledge base"
              aria-label="Search the knowledge base"
            />
          </form>
          {agent && props.q === "" && (
            <NativeSelect
              aria-label="Visibility"
              className="w-40"
              value={props.visibility ?? ""}
              onChange={(e) => {
                const parsed = articleVisibilitySchema.safeParse(e.target.value)
                go({ visibility: parsed.success ? parsed.data : undefined })
              }}
            >
              <option value="">Everything</option>
              {articleVisibilitySchema.options.map((v) => (
                <option key={v} value={v}>
                  {ARTICLE_VISIBILITY_LABEL[v]}
                </option>
              ))}
            </NativeSelect>
          )}
        </div>
        {"found" in props ? (
          props.found.length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">
              Nothing matches “{props.q}”.
            </p>
          ) : (
            <ArticleList articles={props.found} showVisibility={agent} />
          )
        ) : (
          <Feed {...props} showVisibility={agent} />
        )}
      </div>
    </>
  )
}

function Feed({
  first,
  query,
  showVisibility,
}: {
  first: ArticlePage
  query: string
  showVisibility: boolean
}) {
  const feed = useInfiniteQuery({
    queryKey: ["articles", query],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(query)
      if (pageParam !== null) params.set("cursor", pageParam)
      return clientApi(`/articles?${params.toString()}`, {
        schema: articlePageSchema,
      })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    initialData: { pages: [first], pageParams: [null] },
  })
  const articles = feed.data.pages.flatMap((p) => p.items)
  if (articles.length === 0)
    return (
      <p className="mt-6 text-sm text-muted-foreground">No articles yet.</p>
    )
  return (
    <>
      <ArticleList articles={articles} showVisibility={showVisibility} />
      {feed.hasNextPage && (
        <Button
          variant="outline"
          className="mt-4"
          disabled={feed.isFetchingNextPage}
          onClick={() => void feed.fetchNextPage()}
        >
          {feed.isFetchingNextPage && <Spinner />}
          Show more
        </Button>
      )}
    </>
  )
}

function ArticleList({
  articles,
  showVisibility,
}: {
  articles: ArticleSummary[]
  showVisibility: boolean
}) {
  return (
    <ul className="mt-4 grid max-w-3xl divide-y divide-border">
      {articles.map((article) => (
        <li key={article.id} className="py-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <Link
              href={`/knowledge/${article.slug}`}
              className="font-medium hover:underline"
            >
              {article.title}
            </Link>
            {showVisibility && article.visibility !== "PUBLISHED" && (
              <Badge variant="outline">
                {ARTICLE_VISIBILITY_LABEL[article.visibility]}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {article.category === null ? "" : `${article.category.name} · `}
            Updated <RelativeTime at={article.updatedAt} /> by{" "}
            {article.author.displayName}
          </p>
        </li>
      ))}
    </ul>
  )
}
