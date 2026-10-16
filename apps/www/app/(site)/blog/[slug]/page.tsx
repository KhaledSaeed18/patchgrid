import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Suspense } from "react"

import { JsonLd } from "@/components/json-ld"
import { POSTS, findPost, formatDate } from "@/lib/content"
import { pageMetadata } from "@/lib/metadata"
import { blogPosting } from "@/lib/structured-data"

type PageProps = { params: Promise<{ slug: string }> }

export function generateStaticParams() {
  return POSTS.map(({ slug }) => ({ slug }))
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const post = findPost((await params).slug)
  if (!post) return {}
  return pageMetadata({
    title: post.title,
    description: post.description,
    path: `/blog/${post.slug}`,
    article: { publishedTime: post.date },
  })
}

/**
 * The slug is URL data: behind a boundary, a navigation can show the page's
 * frame at once while the post resolves. Every post is prerendered, and the
 * links to them prefetch it, so in practice the fallback is never seen.
 */
export default function PostPage({ params }: PageProps) {
  return (
    <Suspense fallback={<main className="mx-auto min-h-svh max-w-3xl px-6 pt-8 pb-24" />}>
      <Post params={params} />
    </Suspense>
  )
}

async function Post({ params }: PageProps) {
  const { slug } = await params
  // Looked up before the import: an unknown slug never names a module.
  const post = findPost(slug)
  if (!post) notFound()
  const { default: Content } = await import(`@/content/blog/${post.slug}.mdx`)

  return (
    <main className="mx-auto max-w-3xl px-6 pt-8 pb-24">
      <JsonLd data={blogPosting(post)} />
      <Link href="/blog" className="text-sm text-muted-foreground hover:text-foreground">
        ← Blog
      </Link>
      <article className="mt-6">
        <header>
          <time dateTime={post.date} className="text-sm text-muted-foreground">
            {formatDate(post.date)}
          </time>
          <h1 className="mt-2 font-serif text-4xl leading-tight tracking-tight text-balance">
            {post.title}
          </h1>
        </header>
        <Content />
      </article>
    </main>
  )
}
