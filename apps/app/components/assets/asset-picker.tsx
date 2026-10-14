"use client"

import { type LinkedAsset, assetPageSchema } from "@patchgrid/contracts"
import { Input } from "@patchgrid/ui/components/input"
import { useQuery } from "@tanstack/react-query"
import { useDeferredValue, useState } from "react"

import { clientApi } from "@/lib/api/client"
import { ASSET_TYPE_LABEL } from "@/lib/labels"

/**
 * Finds an asset by name or serial number among those the reader can see —
 * a requester's own, an agent's whole register — and hands back the one
 * picked. What it may link is the server's decision; this only searches.
 * `browse` lists the first few before anything is typed — right for a
 * requester's handful of devices, wasteful for an agent's whole register.
 */
export function AssetPicker({
  exclude,
  onPick,
  label = "Find an asset",
  disabled = false,
  browse = false,
}: {
  exclude: readonly string[]
  onPick: (asset: LinkedAsset) => void
  label?: string
  disabled?: boolean
  browse?: boolean
}) {
  const [text, setText] = useState("")
  const q = useDeferredValue(text.trim())
  const found = useQuery({
    queryKey: ["assets", "picker", q],
    enabled: browse || q !== "",
    queryFn: () =>
      clientApi(
        `/assets?limit=8${q === "" ? "" : `&q=${encodeURIComponent(q)}`}`,
        { schema: assetPageSchema }
      ),
  })
  const options = (found.data?.items ?? []).filter(
    (a) => !exclude.includes(a.id) && a.status !== "RETIRED"
  )
  return (
    <div className="grid gap-2">
      <Input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Name or serial number"
        aria-label={label}
        disabled={disabled}
      />
      {options.length > 0 ? (
        <ul className="grid gap-1" aria-label="Matching assets">
          {options.map((asset) => (
            <li key={asset.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onPick({
                    id: asset.id,
                    name: asset.name,
                    type: asset.type,
                    status: asset.status,
                  })
                  setText("")
                }}
                className="flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
              >
                <span className="truncate">{asset.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {asset.serialNumber ?? ASSET_TYPE_LABEL[asset.type]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        found.isSuccess &&
        (browse || q !== "") && (
          <p className="text-xs text-muted-foreground">
            {q === "" ? "No assets to choose from." : `Nothing matches “${q}”.`}
          </p>
        )
      )}
    </div>
  )
}
