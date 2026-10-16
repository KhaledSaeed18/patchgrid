import Link from "next/link"

import { REPO_URL } from "@/lib/config"

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { href: "/pricing", label: "Pricing" },
      { href: "/signup", label: "Create a workspace" },
    ],
  },
  {
    heading: "Learn",
    links: [
      { href: "/docs", label: "Documentation" },
      { href: "/blog", label: "Blog" },
      { href: "/problems", label: "API error reference" },
    ],
  },
  {
    heading: "Source",
    links: [
      { href: REPO_URL, label: "GitHub" },
      { href: `${REPO_URL}/tree/main/docs/decisions`, label: "Decision records" },
      { href: `${REPO_URL}/blob/main/docs/THREAT-MODEL.md`, label: "Threat model" },
    ],
  },
]

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 text-sm sm:grid-cols-[1.5fr_repeat(3,1fr)]">
        <p className="max-w-xs text-muted-foreground">
          Patchgrid, open source under the MIT licence.
        </p>
        {COLUMNS.map((column) => (
          <div key={column.heading}>
            <h2 className="font-medium">{column.heading}</h2>
            <ul className="mt-3 space-y-2">
              {column.links.map((link) => (
                <li key={link.href}>
                  {link.href.startsWith("/") ? (
                    <Link href={link.href} className="text-muted-foreground hover:text-foreground">
                      {link.label}
                    </Link>
                  ) : (
                    <a href={link.href} className="text-muted-foreground hover:text-foreground">
                      {link.label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </footer>
  )
}
