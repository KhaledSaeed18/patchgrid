import Link from "next/link"
import type { Metadata } from "next"

import { PROBLEM_TYPES } from "@/lib/problems"

export const metadata: Metadata = {
  title: "API problem types",
  description:
    "Every error the Patchgrid API returns carries a type URI. This is what each one means.",
}

export default function ProblemsIndexPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-24">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-medium tracking-tight">API problem types</h1>
        <p className="text-muted-foreground leading-relaxed text-pretty">
          The API returns errors as{" "}
          <a
            className="underline underline-offset-4"
            href="https://www.rfc-editor.org/rfc/rfc9457"
          >
            RFC 9457 Problem Details
          </a>
          . Each carries a <code className="font-mono text-xs">type</code> URI that points
          here, so an error is always one click from an explanation.
        </p>
      </div>

      <ul className="flex flex-col gap-1">
        {PROBLEM_TYPES.map((problem) => (
          <li key={problem.slug}>
            <Link
              href={`/problems/${problem.slug}`}
              className="hover:bg-muted/50 -mx-3 flex items-baseline gap-3 rounded-md px-3 py-2"
            >
              <span className="text-muted-foreground w-8 shrink-0 font-mono text-xs">
                {problem.status}
              </span>
              <span className="text-sm">{problem.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
