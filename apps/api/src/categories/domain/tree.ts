import { MAX_CATEGORY_DEPTH } from "@patchgrid/contracts"

/**
 * The taxonomy's rules as pure functions over the whole tree (DOMAIN.md §5).
 * A workspace's categories number in the dozens, so the service reads them
 * all in one query and decides here — no recursive SQL, every rule unit-tested.
 */
export type TreeNode = {
  id: string
  parentId: string | null
  depth: number
  defaultTeamId: string | null
  isActive: boolean
}

const byId = (all: readonly TreeNode[]) => new Map(all.map((n) => [n.id, n]))

/** The node and everything below it. */
export function subtree(id: string, all: readonly TreeNode[]): TreeNode[] {
  const out: TreeNode[] = []
  const queue = [id]
  const nodes = byId(all)
  while (queue.length > 0) {
    const current = queue.shift() ?? ""
    const node = nodes.get(current)
    if (node === undefined) continue
    out.push(node)
    queue.push(...all.filter((n) => n.parentId === current).map((n) => n.id))
  }
  return out
}

/** The node's ancestors, nearest first. */
export function ancestors(id: string, all: readonly TreeNode[]): TreeNode[] {
  const nodes = byId(all)
  const out: TreeNode[] = []
  let current = nodes.get(id)?.parentId ?? null
  while (current !== null) {
    const node = nodes.get(current)
    if (node === undefined) break
    out.push(node)
    current = node.parentId
  }
  return out
}

export type MovePlan =
  | { ok: true; depths: Map<string, number> }
  | { ok: false; reason: "cycle" | "too-deep" | "unknown-parent" | "inactive-parent" }

/**
 * Moving `id` under `parentId` (or to the top): refused if the parent is the
 * node or below it, unknown, inactive, or if any descendant would pass the
 * third level. Otherwise, the new depth of every node in the subtree.
 */
export function planMove(id: string, parentId: string | null, all: readonly TreeNode[]): MovePlan {
  const nodes = byId(all)
  const moving = subtree(id, all)
  if (parentId !== null) {
    if (moving.some((n) => n.id === parentId)) return { ok: false, reason: "cycle" }
    const parent = nodes.get(parentId)
    if (parent === undefined) return { ok: false, reason: "unknown-parent" }
    if (!parent.isActive) return { ok: false, reason: "inactive-parent" }
  }
  const node = nodes.get(id)
  const base = parentId === null ? 1 : (nodes.get(parentId)?.depth ?? 0) + 1
  const shift = base - (node?.depth ?? base)
  const depths = new Map(moving.map((n) => [n.id, n.depth + shift]))
  if ([...depths.values()].some((d) => d > MAX_CATEGORY_DEPTH)) return { ok: false, reason: "too-deep" }
  return { ok: true, depths }
}

/** What a picker shows: active categories whose every ancestor is active too. */
export function visible(all: readonly TreeNode[]): Set<string> {
  return new Set(all.filter((n) => n.isActive && ancestors(n.id, all).every((a) => a.isActive)).map((n) => n.id))
}

/**
 * The team a new ticket in this category routes to: its own default team, or
 * the nearest ancestor's (DOMAIN.md §5). `null` lands in the unassigned queue.
 */
export function routeTeam(categoryId: string, all: readonly TreeNode[]): string | null {
  const self = byId(all).get(categoryId)
  if (self === undefined) return null
  return [self, ...ancestors(categoryId, all)].find((n) => n.defaultTeamId !== null)?.defaultTeamId ?? null
}
