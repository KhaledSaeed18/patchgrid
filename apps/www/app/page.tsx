import Link from "next/link"

export default function Page() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-24">
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
          Patchgrid
        </p>
        <h1 className="text-3xl font-medium tracking-tight text-balance">
          IT service management that models the work, not just the ticket.
        </h1>
        <p className="text-muted-foreground leading-relaxed text-pretty">
          Incidents, service requests, problems and changes are four different things with
          four different lifecycles. Priority is computed from impact and urgency, never
          typed into a dropdown. Each company gets its own workspace, isolated at the
          database level.
        </p>
      </div>

      <div className="text-muted-foreground border-l-2 pl-4 text-sm leading-relaxed">
        Marketing site placeholder — M0. The signup flow, pricing, docs and blog land in M1
        and M10; see <code className="font-mono text-xs">docs/FEATURES.md</code>.
      </div>

      <nav className="flex flex-col gap-2 text-sm">
        <Link href="/problems" className="underline underline-offset-4">
          API problem types
        </Link>
      </nav>
    </main>
  )
}
