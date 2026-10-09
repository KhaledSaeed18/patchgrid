"use client"

import {
  computePriority,
  DEFAULT_SLA_TARGETS,
  type Impact,
  impactSchema,
  type Priority,
  type Urgency,
  urgencySchema,
} from "@patchgrid/contracts"
import { cn } from "@patchgrid/ui/lib/utils"
import { useState } from "react"

const LEVEL: Record<Impact, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
}
const PRIORITY: Record<Priority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
}
const TONE: Record<Priority, string> = {
  LOW: "bg-foreground/[0.06] text-foreground",
  MEDIUM: "bg-primary/20 text-foreground",
  HIGH: "bg-primary/55 text-foreground",
  CRITICAL: "bg-primary text-primary-foreground",
}

/** Rows read top to bottom from high impact to low, as an incident commander reads them. */
const IMPACTS = [...impactSchema.options].reverse()
const URGENCIES = urgencySchema.options

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  const hours = minutes / 60
  return hours === 1 ? "1 hour" : `${hours} hours`
}

/**
 * The hero: the rule that sets Patchgrid apart, working. Pick how widely an
 * outage hurts and how fast it is getting worse; the priority and the clock
 * it starts follow from the same matrix the API applies to every ticket.
 */
export function PriorityMatrix() {
  const [picked, setPicked] = useState<{ impact: Impact; urgency: Urgency }>({
    impact: "HIGH",
    urgency: "HIGH",
  })
  const priority = computePriority(picked.impact, picked.urgency)
  const sla = DEFAULT_SLA_TARGETS[priority]

  return (
    <figure className="w-full max-w-md">
      <div
        className="grid grid-cols-[auto_repeat(3,minmax(0,1fr))] gap-1.5"
        role="group"
        aria-label="Impact by urgency"
      >
        <span />
        <span className="col-span-3 pb-1 text-center text-xs font-medium">
          Urgency
        </span>
        <span className="flex items-end pr-3 pb-1 text-xs font-medium">
          Impact
        </span>
        {URGENCIES.map((u) => (
          <span
            key={u}
            className="pb-1 text-center text-xs text-muted-foreground"
          >
            {LEVEL[u]}
          </span>
        ))}
        {IMPACTS.map((impact) => (
          <div key={impact} className="contents">
            <span className="flex items-center pr-2 text-xs text-muted-foreground">
              {LEVEL[impact]}
            </span>
            {URGENCIES.map((urgency) => {
              const cell = computePriority(impact, urgency)
              const selected =
                picked.impact === impact && picked.urgency === urgency
              return (
                <button
                  key={urgency}
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${LEVEL[impact]} impact, ${LEVEL[urgency].toLowerCase()} urgency: ${PRIORITY[cell]}`}
                  onClick={() => setPicked({ impact, urgency })}
                  className={cn(
                    "flex aspect-[4/3] items-end rounded-[3px] p-2 text-left text-xs font-medium outline-2 outline-offset-2 outline-transparent transition-[outline-color] focus-visible:outline-ring",
                    TONE[cell],
                    selected && "outline-foreground"
                  )}
                >
                  {PRIORITY[cell]}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <figcaption
        className="mt-6 border-t border-border pt-4 text-sm"
        aria-live="polite"
      >
        <p>
          <span className="font-semibold">{PRIORITY[priority]} priority.</span>{" "}
          First response within {duration(sla.response)}, resolved within{" "}
          {duration(sla.resolution)}.
        </p>
        <p className="mt-1 text-muted-foreground">
          Agents set impact and urgency; nobody types a priority. Change either,
          and the deadlines move with it.
        </p>
      </figcaption>
    </figure>
  )
}
