import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Suspense } from "react"

import { JsonLd } from "@/components/json-ld"
import { DOCS, findDoc, neighbours } from "@/lib/content"
import { pageMetadata } from "@/lib/metadata"
import { techArticle } from "@/lib/structured-data"

type PageProps = { params: Promise<{ slug: string }> }

export function generateStaticParams() {
  return DOCS.map(({ slug }) => ({ slug }))
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const doc = findDoc((await params).slug)
  if (!doc) return {}
  return pageMetadata({
    title: doc.title,
    description: doc.description,
    path: `/docs/${doc.slug}`,
  })
}

/** Behind a boundary for the same reason as a blog post: the slug is URL data. */
export default function DocPage({ params }: PageProps) {
  return (
    <Suspense fallback={<main className="min-h-svh max-w-3xl min-w-0" />}>
      <Doc params={params} />
    </Suspense>
  )
}

async function Doc({ params }: PageProps) {
  const { slug } = await params
  // Looked up before the import: an unknown slug never names a module.
  const doc = findDoc(slug)
  if (!doc) notFound()
  const { default: Content } = await import(`@/content/docs/${doc.slug}.mdx`)
  const { previous, next } = neighbours(doc.slug)

  return (
    <main className="max-w-3xl min-w-0">
      <JsonLd data={techArticle(doc)} />
      <p className="text-sm text-muted-foreground">{doc.section}</p>
      <h1 className="mt-2 font-serif text-4xl tracking-tight text-balance">
        {doc.title}
      </h1>
      <article className="mt-2">
        <Content />
      </article>
      <nav
        aria-label="More documentation"
        className="mt-16 flex justify-between gap-6 border-t border-border pt-6 text-sm"
      >
        {previous ? (
          <Link
            href={`/docs/${previous.slug}`}
            prefetch
            className="text-muted-foreground hover:text-foreground"
          >
            ← {previous.title}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link
            href={`/docs/${next.slug}`}
            prefetch
            className="text-right text-muted-foreground hover:text-foreground"
          >
            {next.title} →
          </Link>
        )}
      </nav>
    </main>
  )
}
