"use client"

import type { AssetDetail, TicketPage } from "@patchgrid/contracts"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@patchgrid/ui/components/alert-dialog"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@patchgrid/ui/components/dialog"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { AssetForm } from "@/components/assets/asset-form"
import { PageHeader } from "@/components/page-header"
import { useTenant } from "@/components/tenant-provider"
import { TicketFeed } from "@/components/tickets/ticket-feed"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import { ASSET_STATUS_LABEL, ASSET_TYPE_LABEL } from "@/lib/labels"

export function AssetDetailView({
  asset,
  tickets,
  query,
}: {
  asset: AssetDetail
  tickets: TicketPage
  query: string
}) {
  const { holds } = useTenant()
  const { canEdit, canDelete } = asset.capabilities
  const facts: [string, React.ReactNode][] = [
    ["Type", ASSET_TYPE_LABEL[asset.type]],
    [
      "Status",
      <Badge key="status" variant="outline">
        {ASSET_STATUS_LABEL[asset.status]}
      </Badge>,
    ],
    [
      "Serial number",
      asset.serialNumber === null ? (
        "—"
      ) : (
        <span key="serial" className="font-mono">
          {asset.serialNumber}
        </span>
      ),
    ],
    ["Who has it", asset.owner?.displayName ?? "Nobody"],
    ["Purchased", asset.purchaseDate ?? "—"],
    ["Warranty ends", asset.warrantyExpiresAt ?? "—"],
  ]
  return (
    <>
      <PageHeader
        title={asset.name}
        description={
          <Link href="/assets" className="hover:underline">
            {holds("asset:read_all") ? "Assets" : "My assets"}
          </Link>
        }
        action={
          canEdit || canDelete ? (
            <div className="flex gap-2">
              {canEdit && <EditAsset asset={asset} />}
              {canDelete && <DeleteAsset asset={asset} />}
            </div>
          ) : undefined
        }
      />
      <div className="grid gap-10 px-6 py-6 md:px-10 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <section className="min-w-0">
          <dl className="grid grid-cols-[minmax(0,1fr)] gap-3 text-sm">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-0.5">{value}</dd>
              </div>
            ))}
          </dl>
          {asset.notes !== null && (
            <div className="mt-6">
              <h2 className="text-xs text-muted-foreground">Notes</h2>
              <p className="mt-0.5 text-sm whitespace-pre-wrap">
                {asset.notes}
              </p>
            </div>
          )}
        </section>
        <section className="min-w-0">
          <h2 className="text-sm font-semibold">Tickets about this asset</h2>
          <div className="mt-3">
            <TicketFeed
              first={tickets}
              query={query}
              columns={holds("ticket:assign") ? "console" : "portal"}
              empty={
                <p className="text-sm text-muted-foreground">
                  {asset.ticketCount === 0
                    ? "No ticket has named this asset yet."
                    : "None that you can open."}
                </p>
              }
            />
          </div>
        </section>
      </div>
    </>
  )
}

function EditAsset({ asset }: { asset: AssetDetail }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit {asset.name}</DialogTitle>
          </DialogHeader>
          <AssetForm
            asset={asset}
            onSaved={() => {
              setOpen(false)
              router.refresh()
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

/** For an asset entered by mistake; the server refuses one a ticket names, and says to retire it. */
function DeleteAsset({ asset }: { asset: AssetDetail }) {
  const [confirming, setConfirming] = useState(false)
  const router = useRouter()
  const remove = useMutation({
    mutationFn: () =>
      clientApi(`/assets/${asset.id}`, { method: "DELETE", schema: null }),
    onSuccess: () => router.push("/assets"),
    onError: (error) => {
      setConfirming(false)
      toast.error(failureMessage(error, "The asset wasn't deleted."))
    },
  })
  const named = asset.ticketCount > 0
  return (
    <>
      <Button variant="outline" onClick={() => setConfirming(true)}>
        Delete
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {named ? "Retire it instead" : `Delete ${asset.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {named
                ? "Tickets name this asset, so it stays for their history. Set its status to Retired."
                : "Deleting is for an asset added by mistake. It can't be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{named ? "OK" : "Keep it"}</AlertDialogCancel>
            {!named && (
              <AlertDialogAction
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {remove.isPending && <Spinner />}
                Delete
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
