"use client"

import type { LinkedAsset, Ticket } from "@patchgrid/contracts"
import { useMutation } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { AssetPicker } from "@/components/assets/asset-picker"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import { ASSET_STATUS_LABEL, ASSET_TYPE_LABEL } from "@/lib/labels"

/**
 * What the ticket is about (DOMAIN.md §9.3). Everyone who reads the ticket
 * sees its assets by name; whoever holds the whole register can open them;
 * whoever may link tickets adds and removes them here.
 */
export function Assets({ ticket }: { ticket: Ticket }) {
  const { holds } = useTenant()
  const router = useRouter()
  const canLink = ticket.capabilities.canLink
  const opens = holds("asset:read_all")
  const change = useMutation({
    mutationFn: ({ asset, add }: { asset: LinkedAsset; add: boolean }) =>
      clientApi(`/tickets/${ticket.id}/assets/${asset.id}`, {
        method: add ? "PUT" : "DELETE",
        schema: null,
      }),
    onSuccess: () => router.refresh(),
    onError: (error, { add }) =>
      toast.error(
        failureMessage(
          error,
          add ? "The asset wasn't added." : "The asset wasn't removed."
        )
      ),
  })
  if (ticket.assets.length === 0 && !canLink) return null

  return (
    <section className="min-w-0">
      <h2 className="text-sm font-semibold">Assets</h2>
      {ticket.assets.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-2 text-sm">
          {ticket.assets.map((asset) => (
            <li
              key={asset.id}
              className="flex items-start justify-between gap-2"
            >
              <div className="min-w-0">
                {opens ? (
                  <Link
                    href={`/assets/${asset.id}`}
                    className="block truncate hover:underline"
                  >
                    {asset.name}
                  </Link>
                ) : (
                  <p className="truncate">{asset.name}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {ASSET_TYPE_LABEL[asset.type]} ·{" "}
                  {ASSET_STATUS_LABEL[asset.status]}
                </p>
              </div>
              {canLink && (
                <button
                  type="button"
                  aria-label={`Remove ${asset.name}`}
                  disabled={change.isPending}
                  onClick={() => change.mutate({ asset, add: false })}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canLink && (
        <div className="mt-3">
          <AssetPicker
            label="Add an asset"
            exclude={ticket.assets.map((a) => a.id)}
            disabled={change.isPending}
            onPick={(asset) => change.mutate({ asset, add: true })}
          />
        </div>
      )}
    </section>
  )
}
