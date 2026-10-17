"use client"

import { type SavedView, type SavedViewQuery, savedViewSchema } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@patchgrid/ui/components/dialog"
import { Field, FieldLabel } from "@patchgrid/ui/components/field"
import { Input } from "@patchgrid/ui/components/input"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"
import { z } from "zod"

import { NativeSelect } from "@/components/native-select"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"

/** A saved view as the queue page's address: the query, nothing else (ADR-0052). */
export function viewHref(query: SavedViewQuery): string {
  const params = new URLSearchParams({ view: query.view })
  if (query.type !== undefined) params.set("type", query.type)
  if (query.status !== undefined) params.set("status", query.status)
  if (query.priority !== undefined) params.set("priority", query.priority)
  if (query.sort !== "newest") params.set("sort", query.sort)
  return `/queues?${params.toString()}`
}

/**
 * Saved views (ADR-0052): one's own and those shared with one's teams, as
 * links; the current filters saved under a name, kept or shared with a team.
 * A view is a query, so a shared one shows each colleague their own tickets.
 */
export function SavedViews({ current }: { current: SavedViewQuery }) {
  const { teams } = useTenant()
  const queries = useQueryClient()
  const views = useQuery({ queryKey: ["views"], queryFn: () => clientApi("/views", { schema: z.array(savedViewSchema) }) })
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState("")
  const [teamId, setTeamId] = useState("")

  const save = useMutation({
    mutationFn: () =>
      clientApi("/views", {
        method: "POST",
        body: { name: name.trim(), query: current, ...(teamId === "" ? {} : { teamId }) },
        schema: savedViewSchema,
      }),
    onSuccess: (view) => {
      setSaving(false)
      setName("")
      setTeamId("")
      toast.success(view.team === null ? `Saved "${view.name}".` : `Saved "${view.name}" for ${view.team.name}.`)
      void queries.invalidateQueries({ queryKey: ["views"] })
    },
    onError: (error) => toast.error(failureMessage(error, "The view wasn't saved.")),
  })
  const remove = useMutation({
    mutationFn: (view: SavedView) => clientApi(`/views/${view.id}`, { method: "DELETE", schema: null }),
    onSuccess: () => void queries.invalidateQueries({ queryKey: ["views"] }),
    onError: (error) => toast.error(failureMessage(error, "The view wasn't removed.")),
  })

  const list = views.data ?? []
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Saved views</span>
      {list.length === 0 && <span className="text-xs text-muted-foreground">— none yet</span>}
      {list.map((view) => (
        <span key={view.id} className="inline-flex items-center rounded-full border border-border text-xs">
          <Link href={viewHref(view.query)} className="px-3 py-1 hover:underline" title={view.team === null ? "Yours" : `Shared with ${view.team.name} by ${view.owner.displayName}`}>
            {view.name}
            {view.team !== null && <span className="text-muted-foreground"> · {view.team.name}</span>}
          </Link>
          {view.removable && (
            <button
              type="button"
              aria-label={`Remove ${view.name}`}
              className="border-l border-border px-2 py-1 text-muted-foreground hover:text-foreground"
              onClick={() => remove.mutate(view)}
            >
              ×
            </button>
          )}
        </span>
      ))}
      <Button variant="ghost" size="sm" onClick={() => setSaving(true)}>
        Save this view
      </Button>

      <Dialog open={saving} onOpenChange={(open) => !open && setSaving(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this view</DialogTitle>
            <DialogDescription>
              It keeps the queue and its filters, not the tickets: shared with a team, each colleague sees the tickets
              they themselves can see.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="view-name">Name</FieldLabel>
              <Input id="view-name" value={name} maxLength={60} placeholder="Critical, unassigned" onChange={(e) => setName(e.target.value)} />
            </Field>
            {teams.length > 0 && (
              <Field>
                <FieldLabel htmlFor="view-team">Who sees it</FieldLabel>
                <NativeSelect id="view-team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                  <option value="">Only me</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      Everyone in {team.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaving(false)}>
              Cancel
            </Button>
            <Button disabled={name.trim() === "" || save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Spinner />}
              Save view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
