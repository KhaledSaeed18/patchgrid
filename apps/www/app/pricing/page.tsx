import { PLAN_LIMITS, type UsageMetric } from "@patchgrid/contracts"
import type { Metadata } from "next"
import Link from "next/link"

import { SiteHeader } from "@/components/site-header"

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Patchgrid's Free and Pro plans: agent seats, tickets, storage and automation, side by side.",
}

const ROWS: {
  metric: UsageMetric
  label: string
  unit: (n: number) => string
}[] = [
  {
    metric: "AGENT_SEATS",
    label: "Agents, admins and owners",
    unit: (n) => `${n}`,
  },
  {
    metric: "TICKETS_CREATED",
    label: "Tickets a month",
    unit: (n) => n.toLocaleString("en"),
  },
  {
    metric: "STORAGE_BYTES",
    label: "Attachment storage",
    unit: (n) => `${n / 1024 ** 3} GB`,
  },
  {
    metric: "AUTOMATION_RULES",
    label: "Automation rules",
    unit: (n) => `${n}`,
  },
  {
    metric: "KB_ARTICLES",
    label: "Knowledge base articles",
    unit: (n) => `${n}`,
  },
]

const PLANS = [
  {
    id: "FREE",
    name: "Free",
    blurb: "For a small IT team getting off shared inboxes.",
  },
  {
    id: "PRO",
    name: "Pro",
    blurb: "For a service desk that runs the whole company's requests.",
  },
] as const

/** The numbers come from the one definition the API enforces, so this page cannot promise more than it gets. */
export default function PricingPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-6 pt-12 pb-24">
        <h1 className="font-serif text-4xl tracking-tight">Pricing</h1>
        <p className="mt-3 max-w-xl text-muted-foreground">
          Requesters — everyone who raises tickets — are always free and
          unlimited. You pay for the people who work them.
        </p>
        <div className="mt-12 overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left align-bottom">
                <th className="py-3 pr-6 font-normal text-muted-foreground">
                  <span className="sr-only">Limit</span>
                </th>
                {PLANS.map((plan) => (
                  <th key={plan.id} className="w-1/3 py-3 pr-6 font-normal">
                    <span className="block font-serif text-2xl">
                      {plan.name}
                    </span>
                    <span className="mt-1 block text-muted-foreground">
                      {plan.blurb}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.metric} className="border-b border-border">
                  <th
                    scope="row"
                    className="py-3 pr-6 text-left font-normal text-muted-foreground"
                  >
                    {row.label}
                  </th>
                  {PLANS.map((plan) => {
                    const limit = PLAN_LIMITS[plan.id][row.metric]
                    return (
                      <td key={plan.id} className="py-3 pr-6 tabular-nums">
                        {limit === null ? "Unlimited" : row.unit(limit)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-6 text-sm text-muted-foreground">
          Every workspace starts on Free. Pro is switched on by us for now;
          going over a limit never deletes anything, it only pauses adding more.
        </p>
        <Link
          href="/signup"
          className="mt-8 inline-block rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/85"
        >
          Create a workspace
        </Link>
      </main>
    </>
  )
}
