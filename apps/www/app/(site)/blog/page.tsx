import type { Metadata } from "next"
import Link from "next/link"

import { POSTS, formatDate } from "@/lib/content"
import { pageMetadata } from "@/lib/metadata"

export const metadata: Metadata = pageMetadata({
  title: "Blog",
  description:
    "Notes on building a multi-tenant service desk: the decisions, the alternatives, and what they cost.",
  path: "/blog",
})

export default function BlogIndexPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-8 pb-24">
      <h1 className="font-serif text-4xl tracking-tight">Blog</h1>
      <p className="mt-4 text-lg leading-relaxed text-pretty text-muted-foreground">
        Notes on building Patchgrid: the decisions behind it, what we rejected,
        and what each choice costs. Every post links the decision record it
        comes from.
      </p>
      <ol className="mt-12 divide-y divide-border border-y border-border">
        {POSTS.map((post) => (
          <li key={post.slug}>
            <Link
              href={`/blog/${post.slug}`}
              prefetch
              className="group block py-6"
            >
              <time
                dateTime={post.date}
                className="text-sm text-muted-foreground"
              >
                {formatDate(post.date)}
              </time>
              <h2 className="mt-1 font-serif text-2xl tracking-tight group-hover:underline group-hover:underline-offset-4">
                {post.title}
              </h2>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                {post.description}
              </p>
            </Link>
          </li>
        ))}
      </ol>
    </main>
  )
}
