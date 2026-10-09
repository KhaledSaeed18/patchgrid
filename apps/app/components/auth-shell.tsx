import Link from "next/link"

import { PatchGrid } from "./patch-grid"

/**
 * The frame for every tenant-less page: the form on the left, set to a
 * reading width, and the status grid beside it on wide screens.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <main className="flex flex-col px-6 py-8 sm:px-12">
        <Link
          href="/"
          className="w-fit text-sm font-semibold tracking-tight text-foreground"
        >
          Patchgrid
        </Link>
        <div className="flex flex-1 flex-col justify-center py-12">
          <div className="w-full max-w-sm">
            <h1 className="font-serif text-3xl leading-tight tracking-tight text-balance">
              {title}
            </h1>
            {description !== undefined && (
              <p className="mt-3 text-sm leading-relaxed text-pretty text-muted-foreground">
                {description}
              </p>
            )}
            <div className="mt-8">{children}</div>
            {footer !== undefined && (
              <div className="mt-8 text-sm text-muted-foreground">{footer}</div>
            )}
          </div>
        </div>
      </main>
      <aside className="hidden border-l border-border bg-muted/40 p-10 lg:block">
        <PatchGrid />
      </aside>
    </div>
  )
}
