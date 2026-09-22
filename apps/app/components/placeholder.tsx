import Link from "next/link"

/**
 * Milestone placeholder.
 *
 * Every route group exists from M0 so the shape of the application is visible and
 * `proxy.ts` has real paths to route to in M1 — but the screens themselves arrive
 * with the milestone that gives them something to show. Each placeholder names
 * what it becomes and when, so an empty page is never mistaken for a lost one.
 */
export function Placeholder({
  surface,
  milestone,
  children,
}: {
  surface: string
  milestone: string
  children: React.ReactNode
}) {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-24">
      <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
        {surface} · {milestone}
      </p>
      <div className="text-sm leading-relaxed text-pretty">{children}</div>
      <Link
        href="/"
        className="mt-2 text-sm text-muted-foreground underline underline-offset-4"
      >
        Back
      </Link>
    </main>
  )
}
