import { notFound } from "next/navigation"

import { POSTS, findPost, formatDate } from "@/lib/content"
import { OG_SIZE, OG_TYPE, ogImage } from "@/lib/og"

export const alt = "A post on the Patchgrid blog"
export const size = OG_SIZE
export const contentType = OG_TYPE

export function generateStaticParams() {
  return POSTS.map(({ slug }) => ({ slug }))
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const post = findPost((await params).slug)
  if (!post) notFound()
  return ogImage({
    eyebrow: `Blog · ${formatDate(post.date)}`,
    title: post.title,
  })
}
