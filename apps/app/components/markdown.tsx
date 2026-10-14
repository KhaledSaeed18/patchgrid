import { cn } from "@patchgrid/ui/lib/utils"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

/**
 * Markdown as an article body is written (DOMAIN.md §9.2): headings, lists,
 * tables, code and links — and no raw HTML, which react-markdown never
 * renders unless told to. Its URL filter drops `javascript:` and the like,
 * so a link formats but never scripts. External links open in a new tab.
 * Each element takes only its children, never the parser's props.
 */
export function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "text-sm leading-relaxed text-pretty [&>*:first-child]:mt-0",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h2 className="mt-8 font-serif text-xl">{children}</h2>
          ),
          h2: ({ children }) => (
            <h2 className="mt-8 font-serif text-xl">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-6 font-semibold">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-4 font-semibold">{children}</h4>
          ),
          p: ({ children }) => <p className="mt-3">{children}</p>,
          ul: ({ children }) => (
            <ul className="mt-3 list-disc space-y-1 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mt-3 list-decimal space-y-1 pl-5">{children}</ol>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mt-3 border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-primary underline underline-offset-2"
              {...(href?.startsWith("http") === true
                ? { target: "_blank", rel: "noreferrer noopener" }
                : {})}
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-left">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border px-2 py-1 font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border px-2 py-1">{children}</td>
          ),
          hr: () => <hr className="mt-6 border-border" />,
          // A remote image would tell its host who read the article, and when; its words stand in.
          img: ({ alt }) => (
            <span className="text-muted-foreground">[{alt}]</span>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
