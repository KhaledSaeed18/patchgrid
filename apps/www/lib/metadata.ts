import type { Metadata } from "next"

export const SITE_NAME = "Patchgrid"

/**
 * A page's metadata, whole. A page that sets `openGraph` replaces the layout's
 * rather than merging with it, so every page builds the full set here: title,
 * description, canonical address and the Open Graph fields, which crawlers do
 * not fill in from the title on their own.
 */
export function pageMetadata({
  title,
  description,
  path,
  article,
}: {
  /** Omitted on the home page, which takes the layout's default title. */
  title?: string
  description: string
  path: string
  /** A blog post: its Open Graph type is `article`, with the day it was published. */
  article?: { publishedTime: string }
}): Metadata {
  return {
    ...(title !== undefined && { title }),
    description,
    alternates: { canonical: path },
    openGraph: {
      siteName: SITE_NAME,
      locale: "en_GB",
      url: path,
      title: title ?? SITE_NAME,
      description,
      ...(article ? { type: "article", publishedTime: article.publishedTime } : { type: "website" }),
    },
  }
}
