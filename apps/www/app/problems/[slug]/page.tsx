import Link from "next/link"
import { notFound } from "next/navigation"
import type { Metadata } from "next"

import { PROBLEM_TYPES, findProblemType } from "@/lib/problems"

type PageProps = { params: Promise<{ slug: string }> }

export function generateStaticParams() {
  return PROBLEM_TYPES.map(({ slug }) => ({ slug }))
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const problem = findProblemType(slug)
  if (!problem) return { title: "Unknown problem type" }
  return { title: problem.title, description: problem.detail }
}

export default async function ProblemTypePage({ params }: PageProps) {
  const { slug } = await params
  const problem = findProblemType(slug)
  if (!problem) notFound()

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-24">
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground font-mono text-xs">
          HTTP {problem.status}
        </p>
        <h1 className="text-2xl font-medium tracking-tight">{problem.title}</h1>
        <code className="text-muted-foreground font-mono text-xs break-all">
          https://patchgrid.xyz/problems/{problem.slug}
        </code>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">What happened</h2>
        <p className="text-muted-foreground leading-relaxed text-pretty">
          {problem.detail}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">What to do</h2>
        <p className="text-muted-foreground leading-relaxed text-pretty">
          {problem.resolution}
        </p>
      </section>

      <Link
        href="/problems"
        className="text-muted-foreground text-sm underline underline-offset-4"
      >
        All problem types
      </Link>
    </main>
  )
}
