"use client"

import {
  type OrganizationStatus,
  organizationStatusSchema,
  platformOrgPageSchema,
} from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import { Input } from "@patchgrid/ui/components/input"
import { Spinner } from "@patchgrid/ui/components/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@patchgrid/ui/components/table"
import { useInfiniteQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useState } from "react"

import { NativeSelect } from "@/components/native-select"
import { PageHeader } from "@/components/page-header"
import { platformApi } from "@/lib/api/platform"

import { ORG_STATUS_LABEL, PLAN_LABEL } from "./labels"

/** Every workspace, newest first, as metadata (RBAC.md §8). */
export function OrgList() {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState<OrganizationStatus | "">("")
  const list = useInfiniteQuery({
    queryKey: ["platform", "orgs", q, status],
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: "50" })
      if (q !== "") query.set("q", q)
      if (status !== "") query.set("status", status)
      if (pageParam !== null) query.set("cursor", pageParam)
      return platformApi(`/orgs?${query.toString()}`, {
        schema: platformOrgPageSchema,
      })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  })
  const orgs = list.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Names, plans and status — never what is inside them. Content is reachable only through a support session its owner grants."
      />
      <div className="px-6 py-6 md:px-10">
        <div className="flex flex-wrap gap-3">
          <form
            role="search"
            className="w-full max-w-sm"
            onSubmit={(event) => {
              event.preventDefault()
              setQ(
                String(new FormData(event.currentTarget).get("q") ?? "").trim()
              )
            }}
          >
            <Input
              name="q"
              type="search"
              placeholder="Name or address"
              aria-label="Search workspaces"
            />
          </form>
          <NativeSelect
            aria-label="Status"
            className="w-44"
            value={status}
            onChange={(e) => {
              const parsed = organizationStatusSchema.safeParse(e.target.value)
              setStatus(parsed.success ? parsed.data : "")
            }}
          >
            <option value="">Any status</option>
            {organizationStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {ORG_STATUS_LABEL[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
        {list.isPending ? (
          <Spinner className="mt-6" />
        ) : orgs.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">
            No workspaces match.
          </p>
        ) : (
          <Table className="mt-4">
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Active members</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orgs.map((org) => (
                <TableRow key={org.id}>
                  <TableCell>
                    <Link
                      href={`/orgs/${org.id}`}
                      className="font-medium hover:underline"
                    >
                      {org.name}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">
                      {org.slug}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        org.status === "ACTIVE" ? "outline" : "destructive"
                      }
                    >
                      {ORG_STATUS_LABEL[org.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>{PLAN_LABEL[org.plan]}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {org.activeMembers}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {org.createdAt.slice(0, 10)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {list.hasNextPage && (
          <Button
            variant="outline"
            className="mt-4"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage && <Spinner />}
            Show more
          </Button>
        )}
      </div>
    </>
  )
}
