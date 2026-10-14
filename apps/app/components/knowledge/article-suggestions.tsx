"use client"

import { articleSearchResultSchema } from "@patchgrid/contracts"
import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useEffect, useState } from "react"

import { clientApi } from "@/lib/api/client"

/** Words to wait for before searching, and the pause after typing that triggers it. */
const MIN_LENGTH = 4
const PAUSE_MS = 400

/**
 * "These might help" under a ticket's title (DOMAIN.md §9.2): the published
 * articles that match what the requester is typing, opened in a new tab so
 * the half-written ticket survives. The server decides which articles this
 * reader may see; a requester's search is published articles only.
 */
export function ArticleSuggestions({ title }: { title: string }) {
  const [q, setQ] = useState("")
  useEffect(() => {
    const timer = setTimeout(() => setQ(title.trim()), PAUSE_MS)
    return () => clearTimeout(timer)
  }, [title])
  const found = useQuery({
    queryKey: ["articles", "suggest", q],
    queryFn: () =>
      clientApi(`/articles/search?q=${encodeURIComponent(q)}&limit=3`, {
        schema: articleSearchResultSchema,
      }),
    enabled: q.length >= MIN_LENGTH,
    placeholderData: (previous) => previous,
    staleTime: 60_000,
  })
  const items = q.length >= MIN_LENGTH ? (found.data?.items ?? []) : []
  if (items.length === 0) return null
  return (
    <aside
      aria-label="Articles that might help"
      className="rounded-lg border border-border bg-muted/40 px-4 py-3"
    >
      <p className="text-sm font-medium">These might answer it already</p>
      <ul className="mt-1.5 grid gap-1 text-sm">
        {items.map((article) => (
          <li key={article.id}>
            <Link
              href={`/knowledge/${article.slug}`}
              target="_blank"
              className="text-primary underline-offset-2 hover:underline"
            >
              {article.title}
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  )
}
