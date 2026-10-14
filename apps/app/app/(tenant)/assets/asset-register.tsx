"use client"

import {
  type AssetPage,
  assetPageSchema,
  type AssetStatus,
  assetStatusSchema,
  type AssetType,
  assetTypeSchema,
} from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@patchgrid/ui/components/dialog"
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
import { useRouter } from "next/navigation"
import { useState } from "react"

import { AssetForm } from "@/components/assets/asset-form"
import { NativeSelect } from "@/components/native-select"
import { PageHeader } from "@/components/page-header"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { ASSET_STATUS_LABEL, ASSET_TYPE_LABEL } from "@/lib/labels"

type Filters = {
  q: string
  type: AssetType | undefined
  status: AssetStatus | undefined
}

export function AssetRegister({
  first,
  query,
  filters,
}: {
  first: AssetPage
  query: string
  filters: Filters
}) {
  const { holds } = useTenant()
  const everyone = holds("asset:read_all")
  const router = useRouter()
  const feed = useInfiniteQuery({
    queryKey: ["assets", query],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(query)
      if (pageParam !== null) params.set("cursor", pageParam)
      return clientApi(`/assets?${params.toString()}`, {
        schema: assetPageSchema,
      })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    initialData: { pages: [first], pageParams: [null] },
  })
  const assets = feed.data.pages.flatMap((p) => p.items)
  const filtered =
    filters.q !== "" ||
    filters.type !== undefined ||
    filters.status !== undefined
  const go = (next: Partial<Filters>) => {
    const merged = { ...filters, ...next }
    const params = new URLSearchParams()
    if (merged.q !== "") params.set("q", merged.q)
    if (merged.type !== undefined) params.set("type", merged.type)
    if (merged.status !== undefined) params.set("status", merged.status)
    const search = params.toString()
    router.push(search === "" ? "/assets" : `/assets?${search}`)
  }

  return (
    <>
      <PageHeader
        title={everyone ? "Assets" : "My assets"}
        description={
          everyone
            ? "What the organization owns, who has it, and the tickets raised about it."
            : "The devices and accounts registered to you. Name one when you raise a ticket about it."
        }
        action={holds("asset:write") ? <AddAsset /> : undefined}
      />
      <div className="px-6 py-6 md:px-10">
        <div className="flex flex-wrap gap-3">
          <form
            role="search"
            className="w-full max-w-sm"
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              go({ q: String(data.get("q") ?? "").trim() })
            }}
          >
            <Input
              key={filters.q}
              name="q"
              type="search"
              defaultValue={filters.q}
              placeholder="Name or serial number"
              aria-label="Search assets"
            />
          </form>
          <NativeSelect
            aria-label="Type"
            className="w-44"
            value={filters.type ?? ""}
            onChange={(e) => {
              const parsed = assetTypeSchema.safeParse(e.target.value)
              go({ type: parsed.success ? parsed.data : undefined })
            }}
          >
            <option value="">Every type</option>
            {assetTypeSchema.options.map((t) => (
              <option key={t} value={t}>
                {ASSET_TYPE_LABEL[t]}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Status"
            className="w-40"
            value={filters.status ?? ""}
            onChange={(e) => {
              const parsed = assetStatusSchema.safeParse(e.target.value)
              go({ status: parsed.success ? parsed.data : undefined })
            }}
          >
            <option value="">Any status</option>
            {assetStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {ASSET_STATUS_LABEL[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
        {assets.length === 0 ? (
          <p className="mt-6 max-w-md text-sm text-muted-foreground">
            {filtered
              ? "Nothing matches these filters."
              : everyone
                ? "No assets yet. Add the laptops, phones and systems people raise tickets about."
                : "Nothing is registered to you yet."}
          </p>
        ) : (
          <Table className="mt-4">
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                {everyone && <TableHead>Who has it</TableHead>}
                <TableHead>Warranty ends</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assets.map((asset) => (
                <TableRow
                  key={asset.id}
                  className={
                    asset.status === "RETIRED" ? "opacity-60" : undefined
                  }
                >
                  <TableCell>
                    <Link
                      href={`/assets/${asset.id}`}
                      className="font-medium hover:underline"
                    >
                      {asset.name}
                    </Link>
                    {asset.serialNumber !== null && (
                      <p className="font-mono text-xs text-muted-foreground">
                        {asset.serialNumber}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>{ASSET_TYPE_LABEL[asset.type]}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {ASSET_STATUS_LABEL[asset.status]}
                    </Badge>
                  </TableCell>
                  {everyone && (
                    <TableCell className="text-muted-foreground">
                      {asset.owner?.displayName ?? "Nobody"}
                    </TableCell>
                  )}
                  <TableCell className="text-muted-foreground tabular-nums">
                    {asset.warrantyExpiresAt ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {feed.hasNextPage && (
          <Button
            variant="outline"
            className="mt-4"
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
          >
            {feed.isFetchingNextPage && <Spinner />}
            Show more
          </Button>
        )}
      </div>
    </>
  )
}

function AddAsset() {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Add asset</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add an asset</DialogTitle>
          <DialogDescription>
            Only the name is required. A serial number is unique in this
            workspace.
          </DialogDescription>
        </DialogHeader>
        <AssetForm onSaved={(asset) => router.push(`/assets/${asset.id}`)} />
      </DialogContent>
    </Dialog>
  )
}
