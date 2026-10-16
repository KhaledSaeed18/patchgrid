import type { Metadata } from "next"
import Link from "next/link"

import { DOC_SECTIONS, DOCS } from "@/lib/content"
import { pageMetadata } from "@/lib/metadata"

export const metadata: Metadata = pageMetadata({
  title: "Documentation",
  description:
    "How Patchgrid works: workspaces, tickets and their lifecycles, priority and SLAs, roles, email and the API.",
  path: "/docs",
})

export default function DocsIndexPage() {
  return (
    <main className="max-w-3xl">
      <h1 className="font-serif text-4xl tracking-tight">Documentation</h1>
      <p className="mt-4 text-lg leading-relaxed text-pretty text-muted-foreground">
        How a Patchgrid workspace works, from creating one to building on its
        API. Each page stands on its own; read them in order for the whole
        picture.
      </p>
      {DOC_SECTIONS.map((section) => (
        <section key={section} className="mt-12">
          <h2 className="font-medium">{section}</h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2">
            {DOCS.filter((d) => d.section === section).map((doc) => (
              <li key={doc.slug}>
                <Link
                  href={`/docs/${doc.slug}`}
                  prefetch
                  className="block h-full rounded-lg border border-border p-5 hover:bg-muted/40"
                >
                  <span className="font-medium">{doc.title}</span>
                  <span className="mt-2 block text-sm leading-relaxed text-muted-foreground">
                    {doc.description}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}
