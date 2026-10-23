import { notFound } from "next/navigation"

import { DOCS, findDoc } from "@/lib/content"
import { OG_SIZE, OG_TYPE, ogImage } from "@/lib/og"

export const alt = "Patchgrid documentation"
export const size = OG_SIZE
export const contentType = OG_TYPE

export function generateStaticParams() {
  return DOCS.map(({ slug }) => ({ slug }))
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const doc = findDoc((await params).slug)
  if (!doc) notFound()
  return ogImage({
    eyebrow: `Documentation · ${doc.section}`,
    title: doc.title,
  })
}
