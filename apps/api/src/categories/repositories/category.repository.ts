import { Injectable } from "@nestjs/common"

import { PrismaService } from "../../prisma/prisma.service"

export type CategoryRecord = {
  id: string
  name: string
  parentId: string | null
  depth: number
  defaultTeamId: string | null
  isActive: boolean
  sortOrder: number
}

const RECORD = {
  id: true,
  name: true,
  parentId: true,
  depth: true,
  defaultTeamId: true,
  isActive: true,
  sortOrder: true,
} as const

/** Tenant-owned; every method takes the org and filters on it (TENANCY.md §7). */
@Injectable()
export class CategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The whole taxonomy in one read — dozens of rows, decided in memory. */
  all(orgId: string): Promise<CategoryRecord[]> {
    return this.prisma.db.category.findMany({
      where: { orgId },
      orderBy: [{ depth: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: RECORD,
    })
  }

  /** Serialises changes to the tree, so a move is decided on committed data. */
  async lockTree(orgId: string): Promise<void> {
    await this.prisma.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`categories:${orgId}`}))`
  }

  async create(
    orgId: string,
    data: { name: string; parentId: string | null; depth: number; defaultTeamId: string | null; sortOrder: number },
  ): Promise<CategoryRecord | "name-taken"> {
    try {
      return await this.prisma.db.category.create({ data: { orgId, ...data }, select: RECORD })
    } catch (error) {
      if (isUniqueViolation(error)) return "name-taken"
      throw error
    }
  }

  async update(
    orgId: string,
    id: string,
    data: {
      name?: string
      parentId?: string | null
      depth?: number
      defaultTeamId?: string | null
      isActive?: boolean
      sortOrder?: number
    },
  ): Promise<void | "name-taken"> {
    try {
      await this.prisma.db.category.update({ where: { orgId_id: { orgId, id } }, data })
    } catch (error) {
      if (isUniqueViolation(error)) return "name-taken"
      throw error
    }
  }

  async setDepth(orgId: string, id: string, depth: number): Promise<void> {
    await this.prisma.db.category.update({ where: { orgId_id: { orgId, id } }, data: { depth } })
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}
