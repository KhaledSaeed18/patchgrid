"use client"

import {
  type Attachment,
  attachmentDownloadSchema,
  type Comment,
  type Ticket,
} from "@patchgrid/contracts"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { RelativeTime } from "@/components/tickets/relative-time"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import {
  fileProblem,
  readableSize,
  uploadAttachment,
  uploadFailure,
} from "@/lib/upload"

/**
 * The ticket's files (ADR-0005, ADR-0037). The list is the server's — a file
 * on an internal note is simply absent for someone who may not read notes.
 * Opening one asks for a two-minute link on the files domain, which serves
 * it as a download unless it is a raster image. Attaching goes straight to
 * storage, then the server sniffs the bytes and may refuse them.
 */
export function Files({
  ticket,
  files,
  comments,
}: {
  ticket: Ticket
  files: Attachment[]
  comments: Comment[]
}) {
  const router = useRouter()
  const [uploading, setUploading] = useState(0)
  const notes = new Set(
    comments.filter((c) => c.visibility === "INTERNAL").map((c) => c.id)
  )
  if (files.length === 0 && !ticket.capabilities.canUploadAttachment)
    return null

  const attach = async (picked: FileList | null) => {
    for (const file of Array.from(picked ?? [])) {
      const problem = fileProblem(file)
      if (problem !== null) {
        toast.error(problem)
        continue
      }
      setUploading((n) => n + 1)
      try {
        await uploadAttachment({ ticketId: ticket.id }, file)
      } catch (error) {
        toast.error(uploadFailure(error, file.name))
      } finally {
        setUploading((n) => n - 1)
      }
    }
    router.refresh()
  }

  return (
    <section className="mt-6 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Files</h2>
        {ticket.capabilities.canUploadAttachment && (
          <label className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            {uploading > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Spinner /> Uploading…
              </span>
            ) : (
              "Attach a file"
            )}
            <input
              type="file"
              multiple
              className="sr-only"
              disabled={uploading > 0}
              onChange={(e) => {
                void attach(e.target.files)
                e.target.value = ""
              }}
            />
          </label>
        )}
      </div>
      {files.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No files yet.</p>
      ) : (
        <ul className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-2 text-sm">
          {files.map((file) => (
            <FileRow
              key={file.id}
              file={file}
              internal={file.commentId !== null && notes.has(file.commentId)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function FileRow({ file, internal }: { file: Attachment; internal: boolean }) {
  const router = useRouter()
  const open = useMutation({
    mutationFn: () =>
      clientApi(`/attachments/${file.id}/download`, {
        schema: attachmentDownloadSchema,
      }),
    // A fresh tab for the files domain; it serves a download or a picture, never a page of ours.
    onSuccess: (link) => window.open(link.url, "_blank", "noopener,noreferrer"),
    onError: (error) =>
      toast.error(failureMessage(error, "That file couldn't be opened.")),
  })
  const remove = useMutation({
    mutationFn: () =>
      clientApi(`/attachments/${file.id}`, { method: "DELETE", schema: null }),
    onSuccess: () => router.refresh(),
    onError: (error) =>
      toast.error(failureMessage(error, "That file wasn't removed.")),
  })
  return (
    <li className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => open.mutate()}
          disabled={open.isPending}
          className="block max-w-full truncate text-left hover:underline"
        >
          {file.filename}
        </button>
        <p className="text-xs text-muted-foreground">
          {readableSize(file.sizeBytes)} · {file.uploader.displayName}{" "}
          <RelativeTime at={file.createdAt} />
          {internal && " · on an internal note"}
        </p>
      </div>
      {file.canDelete && (
        <button
          type="button"
          aria-label={`Remove ${file.filename}`}
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
          className="text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      )}
    </li>
  )
}
