import type { Category } from "@patchgrid/contracts"

/**
 * The flat category list the API serves (DOMAIN.md §5), in reading order:
 * each parent followed by its children, siblings by `sortOrder` then name.
 * A child whose parent is missing from the list is dropped with it — an
 * inactive parent filtered out takes its subtree along.
 */
export function inTreeOrder<
  T extends Pick<Category, "id" | "parentId" | "name" | "sortOrder">,
>(categories: readonly T[]): T[] {
  const children = new Map<string | null, T[]>()
  for (const category of categories) {
    const siblings = children.get(category.parentId) ?? []
    siblings.push(category)
    children.set(category.parentId, siblings)
  }
  const ordered: T[] = []
  const visit = (parentId: string | null) => {
    const siblings = [...(children.get(parentId) ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
    )
    for (const category of siblings) {
      ordered.push(category)
      visit(category.id)
    }
  }
  visit(null)
  return ordered
}

/** "Hardware / Laptops / Battery" — what a picker shows, since names repeat under different parents. */
export function categoryPath(
  category: Pick<Category, "id" | "parentId" | "name">,
  byId: ReadonlyMap<string, Pick<Category, "id" | "parentId" | "name">>
): string {
  const names = [category.name]
  let parentId = category.parentId
  while (parentId !== null) {
    const parent = byId.get(parentId)
    if (parent === undefined) break
    names.unshift(parent.name)
    parentId = parent.parentId
  }
  return names.join(" / ")
}
