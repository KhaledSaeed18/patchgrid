"use client"

import Link from "next/link"
import { useEffect } from "react"

import { useTenant } from "@/components/tenant-provider"
import { markSupportOperator } from "@/lib/api/client"
import { adminOrigin } from "@/lib/config"

/**
 * The support session, said out loud (ADR-0020, ADR-0041). To the operator:
 * read-only, and everything recorded. To the workspace's admins and owners:
 * who can read it, and until when, with the way to end it.
 */
export function SupportBanner() {
  const { support, org } = useTenant()
  const operator = support?.kind === "operator"
  useEffect(() => markSupportOperator(operator), [operator])
  if (support === null) return null
  const until = new Date(support.expiresAt).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  })
  if (support.kind === "operator") {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-3 bg-foreground px-6 py-2 text-sm text-background md:px-10"
      >
        <span>
          <strong>Read-only support session</strong> in {org.name}, until{" "}
          {until}. Every page you open is recorded in its audit log.
        </span>
        <a
          href={`${adminOrigin()}/orgs/${org.id}`}
          className="underline underline-offset-4"
        >
          Back to operations
        </a>
      </div>
    )
  }
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 bg-primary/15 px-6 py-2 text-sm md:px-10"
    >
      <span>
        <strong>{support.operatorName}</strong> from Patchgrid support can read
        this workspace until {until}.
      </span>
      <Link href="/settings/support" className="underline underline-offset-4">
        Review support access
      </Link>
    </div>
  )
}
