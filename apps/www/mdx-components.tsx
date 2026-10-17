import type { MDXComponents } from "mdx/types"
import Link from "next/link"
import type { ComponentPropsWithoutRef } from "react"

import { WebhookEvents } from "@/components/webhook-events"
import { anchorFor, textOf } from "@/lib/headings"

/**
 * How the docs and the blog look: Markdown's elements in the design system's
 * type, mapped once here rather than through a typography plugin, so the prose
 * uses the same tokens as every other page.
 */
const components = {
  h2: ({ children }) => {
    const id = anchorFor(textOf(children))
    return (
      <h2 id={id} className="mt-12 scroll-mt-8 font-serif text-2xl tracking-tight text-balance">
        <a href={`#${id}`} className="no-underline">
          {children}
        </a>
      </h2>
    )
  },
  h3: ({ children }) => {
    const id = anchorFor(textOf(children))
    return (
      <h3 id={id} className="mt-8 scroll-mt-8 font-semibold">
        <a href={`#${id}`} className="no-underline">
          {children}
        </a>
      </h3>
    )
  },
  p: (props) => <p className="mt-4 leading-7 text-pretty" {...props} />,
  a: ({ href = "", children }: ComponentPropsWithoutRef<"a">) =>
    href.startsWith("/") || href.startsWith("#") ? (
      <Link href={href} className="underline underline-offset-4 hover:text-muted-foreground">
        {children}
      </Link>
    ) : (
      <a href={href} className="underline underline-offset-4 hover:text-muted-foreground">
        {children}
      </a>
    ),
  ul: (props) => <ul className="mt-4 list-disc space-y-2 pl-6 marker:text-muted-foreground" {...props} />,
  ol: (props) => <ol className="mt-4 list-decimal space-y-2 pl-6 marker:text-muted-foreground" {...props} />,
  li: (props) => <li className="pl-1 leading-7 [&>ol]:mt-2 [&>ul]:mt-2" {...props} />,
  strong: (props) => <strong className="font-semibold" {...props} />,
  code: (props) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...props} />,
  pre: (props) => (
    <pre
      className="mt-6 overflow-x-auto rounded-lg border border-border bg-muted/50 p-4 font-mono text-sm leading-6 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em]"
      {...props}
    />
  ),
  blockquote: (props) => (
    <blockquote className="mt-6 border-l-2 border-border pl-4 text-muted-foreground" {...props} />
  ),
  hr: () => <hr className="my-10 border-border" />,
  table: (props) => (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: (props) => <th className="border-b border-border py-2 pr-4 text-left font-medium" {...props} />,
  td: (props) => <td className="border-b border-border py-2 pr-4 align-top" {...props} />,
  WebhookEvents,
} satisfies MDXComponents

export function useMDXComponents(): MDXComponents {
  return components
}
