"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { DOC_SECTIONS, DOCS } from "@/lib/content"

/** The docs sidebar, section by section, with the page being read marked. */
export function DocsNav() {
  const pathname = usePathname()
  const current = DOCS.find((d) => pathname === `/docs/${d.slug}`)
  return (
    <nav aria-label="Documentation" className="text-sm lg:sticky lg:top-8 lg:self-start">
      {/* Folded on narrow screens, where the full list would push the page below the fold. */}
      <details className="rounded-lg border border-border px-4 py-3 lg:hidden">
        <summary className="cursor-pointer font-medium">{current?.title ?? "All documentation"}</summary>
        <div className="mt-4">
          <Sections pathname={pathname} />
        </div>
      </details>
      <div className="hidden lg:block">
        <Sections pathname={pathname} />
      </div>
    </nav>
  )
}

function Sections({ pathname }: { pathname: string }) {
  return DOC_SECTIONS.map((section) => (
    <div key={section} className="mb-6 last:mb-0">
      <h2 className="mb-2 font-medium">{section}</h2>
      <ul className="space-y-1.5 border-l border-border">
        {DOCS.filter((d) => d.section === section).map((doc) => {
          const href = `/docs/${doc.slug}`
          const current = pathname === href
          return (
            <li key={doc.slug}>
              <Link
                href={href}
                prefetch
                aria-current={current ? "page" : undefined}
                className={
                  current
                    ? "-ml-px block border-l border-foreground pl-3 text-foreground"
                    : "-ml-px block border-l border-transparent pl-3 text-muted-foreground hover:text-foreground"
                }
              >
                {doc.title}
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  ))
}
