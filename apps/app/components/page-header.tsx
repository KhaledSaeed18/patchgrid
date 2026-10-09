/** The top of a workspace page: what it is, one line on what it is for, and its main action. */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border px-6 pt-8 pb-5 md:px-10">
      <div className="max-w-2xl min-w-0">
        <h1 className="font-serif text-2xl tracking-tight">{title}</h1>
        {description !== undefined && (
          <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action}
    </header>
  )
}

/** A titled block within a settings page. */
export function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-4 border-b border-border px-6 py-8 md:grid-cols-[16rem_minmax(0,1fr)] md:gap-10 md:px-10">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description !== undefined && (
          <p className="mt-1 text-sm text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="max-w-xl">{children}</div>
    </section>
  )
}
