import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"

import type { PrismaService } from "../prisma/prisma.service"
import type { StorageService } from "../storage/storage.service"
import { ExportBuilder, safeName } from "./export-builder"
import type { ExportReaderRepository } from "./repositories/export-reader.repository"

const reader = {
  readers: [{ file: "tickets", read: async () => ({ rows: Array.from({ length: 50 }, (_, i) => ({ id: String(i), body: "x".repeat(2000) })), next: null }) }],
  attachments: async () => [],
} as unknown as ExportReaderRepository
const prisma = { transaction: async <T>(fn: () => Promise<T>) => fn() } as unknown as PrismaService

describe("ExportBuilder", () => {
  it("fails, and removes what it stored, when the upload fails — it never waits for a drain that will not come", async () => {
    const remove = vi.fn(async () => undefined)
    const storage = {
      // Nobody reads the stream, and the upload gives up: the classic hang.
      uploadStream: () => ({ stream: new PassThrough({ highWaterMark: 16 }), done: Promise.reject(new Error("part upload failed")) }),
      remove,
    } as unknown as StorageService
    await expect(new ExportBuilder(reader, storage, prisma).build("o-1", "x-1", { name: "Acme", slug: "acme" }, new Date(0))).rejects.toThrow(
      "part upload failed",
    )
    expect(remove).toHaveBeenCalledWith("org/o-1/exports/x-1.zip")
  })

  it("names files safely inside the archive", () => {
    expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd")
    expect(safeName("a\u0000b\nc.txt")).toBe("abc.txt")
    expect(safeName("...")).toBe("file")
  })
})
