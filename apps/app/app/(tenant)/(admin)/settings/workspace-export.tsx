"use client"

import {
  EXPORT_LINK_HOURS,
  exportDownloadSchema,
  type OrgExport,
  orgExportSchema,
} from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { z } from "zod"

import { Section } from "@/components/page-header"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { failureMessage } from "@/lib/failure"

const STATUS: Record<OrgExport["status"], string> = {
  QUEUED: "Waiting",
  RUNNING: "Being made",
  READY: "Ready",
  FAILED: "Failed",
  EXPIRED: "Expired",
}

/**
 * The owner's copy of everything (ADR-0028, ADR-0044): one export a day,
 * made in the background, mailed when ready and downloadable here while its
 * link lasts.
 */
export function WorkspaceExport() {
  const queries = useQueryClient()
  const exports = useQuery({
    queryKey: ["org", "exports"],
    queryFn: () =>
      clientApi("/org/exports", { schema: z.array(orgExportSchema) }),
    // While one is being made, look again now and then.
    refetchInterval: (query) =>
      query.state.data?.some(
        (e) => e.status === "QUEUED" || e.status === "RUNNING"
      ) === true
        ? 3_000
        : false,
  })
  const request = useMutation({
    mutationFn: () =>
      clientApi("/org/exports", { method: "POST", schema: orgExportSchema }),
    onSuccess: () => {
      toast.success("Export started. You'll get an email when it's ready.")
      void queries.invalidateQueries({ queryKey: ["org", "exports"] })
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.status === 429
          ? "A workspace can be exported once a day. The latest export is listed below."
          : failureMessage(error, "The export didn't start.")
      ),
  })
  const download = useMutation({
    mutationFn: (id: string) =>
      clientApi(`/org/exports/${id}/download`, {
        schema: exportDownloadSchema,
      }),
    onSuccess: (link) => window.location.assign(link.url),
    onError: (error) =>
      toast.error(failureMessage(error, "The export can't be downloaded.")),
  })

  return (
    <Section
      title="Export"
      description={`Everything in this workspace — tickets, comments with internal notes, files, assets, articles, members and the audit log — as a zip of JSON files. One a day; each download link lasts ${String(EXPORT_LINK_HOURS)} hours.`}
    >
      <div className="grid gap-3">
        <Button
          className="w-fit"
          disabled={request.isPending}
          onClick={() => request.mutate()}
        >
          {request.isPending && <Spinner />}
          Export everything
        </Button>
        {(exports.data ?? []).map((e) => (
          <div
            key={e.id}
            className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 text-sm"
          >
            <span>
              {new Date(e.requestedAt).toLocaleString()}{" "}
              <span className="text-muted-foreground">
                by {e.requestedBy.displayName}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <Badge
                variant={e.status === "FAILED" ? "destructive" : "outline"}
              >
                {STATUS[e.status]}
              </Badge>
              {e.status === "READY" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={download.isPending}
                  onClick={() => download.mutate(e.id)}
                >
                  Download
                </Button>
              )}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}
