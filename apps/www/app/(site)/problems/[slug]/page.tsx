import Link from "next/link"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import type { Metadata } from "next"

import { pageMetadata } from "@/lib/metadata"
import { PROBLEM_TYPES, findProblemType } from "@/lib/problems"

type PageProps = { params: Promise<{ slug: string }> }

export function generateStaticParams() {
  return PROBLEM_TYPES.map(({ slug }) => ({ slug }))
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params
  const problem = findProblemType(slug)
  if (!problem) return { title: "Unknown problem type" }
  return pageMetadata({
    title: problem.title,
    description: problem.detail,
    path: `/problems/${problem.slug}`,
  })
}

/** Behind a boundary like the docs and the blog: the slug is URL data. */
export default function ProblemTypePage({ params }: PageProps) {
  return (
    <Suspense fallback={<main className="mx-auto min-h-svh max-w-2xl px-6 py-24" />}>
      <ProblemType params={params} />
    </Suspense>
  )
}

async function ProblemType({ params }: PageProps) {
  const { slug } = await params
  const problem = findProblemType(slug)
  if (!problem) notFound()

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-24">
      <div className="flex flex-col gap-3">
        <p className="font-mono text-xs text-muted-foreground">
          HTTP {problem.status}
        </p>
        <h1 className="text-2xl font-medium tracking-tight">{problem.title}</h1>
        <code className="font-mono text-xs break-all text-muted-foreground">
          https://patchgrid.xyz/problems/{problem.slug}
        </code>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">What happened</h2>
        <p className="leading-relaxed text-pretty text-muted-foreground">
          {problem.detail}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">What to do</h2>
        <p className="leading-relaxed text-pretty text-muted-foreground">
          {problem.resolution}
        </p>
      </section>

      <Link
        href="/problems"
        className="text-sm text-muted-foreground underline underline-offset-4"
      >
        All problem types
      </Link>
    </main>
  )
}
