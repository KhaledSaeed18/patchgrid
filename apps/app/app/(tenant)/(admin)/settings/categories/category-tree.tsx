"use client"

import {
  type Category,
  categorySchema,
  MAX_CATEGORY_DEPTH,
  type Team,
} from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@patchgrid/ui/components/dialog"
import { Field, FieldGroup, FieldLabel } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@patchgrid/ui/components/table"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { FormField } from "@/components/form-field"
import { NativeSelect } from "@/components/native-select"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { categoryPath, inTreeOrder } from "@/lib/category-tree"
import { failureMessage } from "@/lib/failure"
import { newIdempotencyKey } from "@/lib/idempotency"

/** What the dialog is doing: adding under a parent (or at the top), or editing one. */
type Editing =
  | { kind: "create"; parent: Category | null }
  | { kind: "edit"; category: Category }

export function CategoryTree({
  initial,
  teams,
}: {
  initial: Category[]
  teams: Team[]
}) {
  const { holds } = useTenant()
  const canWrite = holds("category:write")
  const router = useRouter()
  const [editing, setEditing] = useState<Editing | null>(null)
  const ordered = useMemo(() => inTreeOrder(initial), [initial])
  const byId = useMemo(() => new Map(initial.map((c) => [c.id, c])), [initial])
  const teamName = useMemo(
    () => new Map(teams.map((t) => [t.id, t.name])),
    [teams]
  )

  const toggle = useMutation({
    mutationFn: (category: Category) =>
      clientApi(`/categories/${category.id}`, {
        method: "PATCH",
        body: { isActive: !category.isActive },
        schema: categorySchema,
      }),
    onSuccess: (category) => {
      toast.success(
        category.isActive
          ? `${category.name} is offered again`
          : `${category.name} is no longer offered`
      )
      router.refresh()
    },
    onError: (error) =>
      toast.error(failureMessage(error, "That change didn't go through.")),
  })

  return (
    <div className="px-6 py-6 md:px-10">
      {canWrite && (
        <div className="flex justify-end">
          <Button onClick={() => setEditing({ kind: "create", parent: null })}>
            Add category
          </Button>
        </div>
      )}
      {ordered.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No categories yet. Add one so people can say what a ticket is about.
        </p>
      ) : (
        <Table className="mt-4">
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Routes to</TableHead>
              {canWrite && (
                <TableHead className="w-0">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((category) => (
              <TableRow
                key={category.id}
                className={category.isActive ? undefined : "opacity-60"}
              >
                <TableCell>
                  <span
                    className="inline-flex items-center"
                    style={{ paddingLeft: `${(category.depth - 1) * 1.5}rem` }}
                  >
                    {category.depth > 1 && (
                      <span aria-hidden className="mr-2 h-px w-3 bg-border" />
                    )}
                    <span
                      className={
                        category.depth === 1 ? "font-medium" : undefined
                      }
                    >
                      {category.name}
                    </span>
                    {!category.isActive && (
                      <Badge variant="outline" className="ml-2">
                        Not offered
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <RoutesTo
                    category={category}
                    byId={byId}
                    teamName={teamName}
                  />
                </TableCell>
                {canWrite && (
                  <TableCell className="whitespace-nowrap">
                    {category.isActive &&
                      category.depth < MAX_CATEGORY_DEPTH && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setEditing({ kind: "create", parent: category })
                          }
                        >
                          Add below
                        </Button>
                      )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing({ kind: "edit", category })}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate(category)}
                    >
                      {category.isActive ? "Stop offering" : "Offer again"}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editing !== null && (
        <CategoryDialog
          key={
            editing.kind === "edit"
              ? editing.category.id
              : `new-${editing.parent?.id ?? "top"}`
          }
          editing={editing}
          categories={initial}
          teams={teams}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function CategoryDialog({
  editing,
  categories,
  teams,
  onClose,
}: {
  editing: Editing
  categories: Category[]
  teams: Team[]
  onClose: () => void
}) {
  const router = useRouter()
  const current = editing.kind === "edit" ? editing.category : null
  const byId = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories]
  )
  // A parent must leave room below it, and a category cannot sit inside itself.
  const parents = useMemo(
    () =>
      inTreeOrder(categories).filter(
        (c) =>
          c.isActive &&
          c.depth < MAX_CATEGORY_DEPTH &&
          (current === null || !isWithin(c, current.id, byId))
      ),
    [categories, current, byId]
  )

  const save = useMutation({
    mutationFn: (form: {
      name: string
      parentId: string | null
      defaultTeamId: string | null
    }) =>
      current === null
        ? clientApi("/categories", {
            method: "POST",
            body: {
              name: form.name,
              ...(form.parentId === null ? {} : { parentId: form.parentId }),
              ...(form.defaultTeamId === null
                ? {}
                : { defaultTeamId: form.defaultTeamId }),
            },
            schema: categorySchema,
            idempotencyKey: newIdempotencyKey(),
          })
        : clientApi(`/categories/${current.id}`, {
            method: "PATCH",
            body: form,
            schema: categorySchema,
          }),
    onSuccess: (category) => {
      toast.success(
        current === null ? `${category.name} added` : `${category.name} saved`
      )
      onClose()
      router.refresh()
    },
  })

  const error = save.error
  const nameError =
    error instanceof ApiError
      ? (error.fieldError("name") ??
        (error.status === 409
          ? "There is already a category with that name here."
          : undefined))
      : undefined
  const parentError =
    error instanceof ApiError ? error.fieldError("parentId") : undefined
  const otherError =
    error !== null && nameError === undefined && parentError === undefined
      ? failureMessage(error, "That change didn't go through.")
      : undefined

  const parentDefault =
    editing.kind === "create"
      ? (editing.parent?.id ?? "")
      : (editing.category.parentId ?? "")

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {current === null ? "Add a category" : `Edit ${current.name}`}
          </DialogTitle>
          <DialogDescription>
            {current === null
              ? "Names only need to be unique among their siblings."
              : "Tickets already in this category keep it."}
          </DialogDescription>
        </DialogHeader>
        <form
          id="category-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const parentId = String(data.get("parentId") ?? "")
            const defaultTeamId = String(data.get("defaultTeamId") ?? "")
            save.mutate({
              name: String(data.get("name") ?? "").trim(),
              parentId: parentId === "" ? null : parentId,
              defaultTeamId: defaultTeamId === "" ? null : defaultTeamId,
            })
          }}
        >
          <FieldGroup>
            <FormField
              id="category-name"
              name="name"
              label="Name"
              defaultValue={current?.name}
              placeholder="Printers"
              required
              autoFocus
              error={nameError}
            />
            <Field data-invalid={parentError !== undefined ? true : undefined}>
              <FieldLabel htmlFor="category-parent">Sits under</FieldLabel>
              <NativeSelect
                id="category-parent"
                name="parentId"
                defaultValue={parentDefault}
                aria-invalid={parentError !== undefined ? true : undefined}
              >
                <option value="">Nothing — a top-level category</option>
                {parents.map((c) => (
                  <option key={c.id} value={c.id}>
                    {categoryPath(c, byId)}
                  </option>
                ))}
              </NativeSelect>
              {parentError !== undefined && (
                <p className="text-sm text-destructive">{parentError}</p>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="category-team">Send tickets to</FieldLabel>
              <NativeSelect
                id="category-team"
                name="defaultTeamId"
                defaultValue={current?.defaultTeamId ?? ""}
              >
                <option value="">
                  Inherited from the category above
                </option>
                {teams
                  .filter((t) => t.isActive || t.id === current?.defaultTeamId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          </FieldGroup>
        </form>
        {otherError !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {otherError}
          </p>
        )}
        <DialogFooter>
          <Button type="submit" form="category-form" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {current === null ? "Add category" : "Save category"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Where a new ticket in this category goes: its own team, or the nearest
 * ancestor's — the API routes the same way (DOMAIN.md §5).
 */
function RoutesTo({
  category,
  byId,
  teamName,
}: {
  category: Category
  byId: ReadonlyMap<string, Category>
  teamName: ReadonlyMap<string, string>
}) {
  let node: Category | undefined = category
  while (node !== undefined && node.defaultTeamId === null) {
    node = node.parentId === null ? undefined : byId.get(node.parentId)
  }
  if (node === undefined || node.defaultTeamId === null) return <>Triage</>
  const name = teamName.get(node.defaultTeamId) ?? "A removed team"
  return node.id === category.id ? (
    <>{name}</>
  ) : (
    <span className="text-muted-foreground/70">
      {name}, from {node.name}
    </span>
  )
}

/** Whether `category` is `ancestorId` or somewhere beneath it. */
function isWithin(
  category: Category,
  ancestorId: string,
  byId: ReadonlyMap<string, Category>
): boolean {
  let node: Category | undefined = category
  while (node !== undefined) {
    if (node.id === ancestorId) return true
    node = node.parentId === null ? undefined : byId.get(node.parentId)
  }
  return false
}
