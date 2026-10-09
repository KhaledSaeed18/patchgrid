import Link from "next/link"

import { PriorityMatrix } from "@/components/priority-matrix"
import { SiteHeader } from "@/components/site-header"

/** The four kinds of work: a set, each with its own lifecycle — not a sequence. */
const WORK = [
  {
    name: "Incidents",
    text: "Something is broken. Restore it fast, against a clock that pauses only while you wait on the reporter.",
  },
  {
    name: "Service requests",
    text: "Someone needs something standard: a laptop, access, a mailbox. Pre-approved by definition, still on the clock.",
  },
  {
    name: "Problems",
    text: "The cause behind repeat incidents. Link the incidents to it, record the workaround, close it with a change.",
  },
  {
    name: "Changes",
    text: "A planned modification, approved before it runs — by the lead of the team doing it, never by its author.",
  },
]

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-14 px-6 pt-12 pb-24 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:pt-20">
          <div className="max-w-xl">
            <h1 className="font-serif text-4xl leading-[1.1] tracking-tight text-balance sm:text-5xl">
              The help desk that works out what matters first.
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-pretty text-muted-foreground">
              Patchgrid is IT service management for teams who run the systems
              everyone else depends on. Priority comes from impact and urgency,
              not from whoever shouts loudest, and every deadline follows from
              it.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                href="/signup"
                className="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/85"
              >
                Create a workspace
              </Link>
              <Link
                href="/pricing"
                className="text-sm underline underline-offset-4"
              >
                See what the free plan includes
              </Link>
            </div>
          </div>
          <PriorityMatrix />
        </section>

        <section className="border-t border-border bg-muted/40">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 className="max-w-xl font-serif text-3xl tracking-tight text-balance">
              Four kinds of work, four lifecycles.
            </h2>
            <p className="mt-3 max-w-xl text-muted-foreground">
              A ticket isn&rsquo;t one thing. Each type moves through its own
              states, and only the moves that make sense for it are offered.
            </p>
            <dl className="mt-12 grid gap-x-12 gap-y-10 sm:grid-cols-2">
              {WORK.map((w) => (
                <div key={w.name} className="max-w-md">
                  <dt className="font-semibold">{w.name}</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {w.text}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <h2 className="font-serif text-3xl tracking-tight text-balance">
                Your company gets its own workspace.
              </h2>
              <p className="mt-3 max-w-lg leading-relaxed text-muted-foreground">
                Each workspace has its own address, its own members and roles,
                and its data sealed off from every other company&rsquo;s by the
                database itself — not just by the application in front of it.
                Belong to more than one? Keep both open in two tabs.
              </p>
            </div>
            <div className="self-center rounded-lg border border-border bg-card p-6 font-mono text-sm leading-7">
              <p>acme.patchgrid.xyz</p>
              <p>globex.patchgrid.xyz</p>
              <p className="text-muted-foreground">your-team.patchgrid.xyz</p>
            </div>
          </div>
        </section>
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-4 px-6 py-8 text-sm text-muted-foreground">
          <p>Patchgrid, open source under the MIT licence.</p>
          <Link href="/problems" className="hover:text-foreground">
            API error reference
          </Link>
        </div>
      </footer>
    </>
  )
}
