import { SITE_URL } from "@/lib/config"
import type { Doc, Post } from "@/lib/content"
import { SITE_NAME } from "@/lib/metadata"

/**
 * schema.org descriptions of the pages that have something to describe, for
 * search engines and anything else that reads JSON-LD. Plain objects; the
 * `JsonLd` component serialises them.
 */
type Thing = Record<string, unknown>

const url = (path: string) => new URL(path, SITE_URL).toString()
const publisher = { "@type": "Organization", name: SITE_NAME, url: url("/") }

export function softwareApplication(description: string): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    description,
    url: url("/"),
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    // The Free plan: what a stranger can have today without talking to anyone.
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  }
}

export function techArticle(doc: Doc): Thing[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: doc.title,
      description: doc.description,
      url: url(`/docs/${doc.slug}`),
      publisher,
    },
    breadcrumbs([
      ["Documentation", "/docs"],
      [doc.title, `/docs/${doc.slug}`],
    ]),
  ]
}

export function blogPosting(post: Post): Thing[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      datePublished: post.date,
      url: url(`/blog/${post.slug}`),
      author: publisher,
      publisher,
    },
    breadcrumbs([
      ["Blog", "/blog"],
      [post.title, `/blog/${post.slug}`],
    ]),
  ]
}

function breadcrumbs(trail: [name: string, path: string][]): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map(([name, path], index) => ({
      "@type": "ListItem",
      position: index + 1,
      name,
      item: url(path),
    })),
  }
}

/**
 * JSON for inside a `<script>`. `JSON.stringify` leaves `<` alone, so a title
 * holding `</script>` would end the element early; escaped, it cannot.
 */
export const serialise = (data: Thing | Thing[]): string => JSON.stringify(data).replace(/</g, "\\u003c")
