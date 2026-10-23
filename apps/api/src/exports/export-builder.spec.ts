import { PassThrough, Readable } from "node:stream"
import { describe, expect, it, vi } from "vitest"

import type { PrismaService } from "../prisma/prisma.service"
import type { StorageService } from "../storage/storage.service"
import { ExportBuilder, safeName } from "./export-builder"
import { EXPORT_PAGE, type ExportAttachment, type ExportReaderRepository } from "./repositories/export-reader.repository"

/** `count` one-byte files, and the order things happened in. */
function harness(count: number, options: { uploadFails?: boolean } = {}) {
  const events: string[] = []
  const files: ExportAttachment[] = Array.from(
    { length: count },
    (_, i) =>
      ({
        id: `a-${String(i).padStart(5, "0")}`,
        ticketId: "t-1",
        commentId: null,
        filename: `f${String(i)}.txt`,
        mimeType: "text/plain",
        sizeBytes: 1,
        createdAt: new Date(0),
        storageKey: `k-${String(i)}`,
      }) as unknown as ExportAttachment,
  )
  const reader = {
    readers: [],
    attachments: vi.fn(async (_o: string, after: string | null) => {
      const from = after === null ? 0 : files.findIndex((f) => f.id === after) + 1
      events.push(`page from ${String(from)}`)
      return files.slice(from, from + EXPORT_PAGE)
    }),
  }
  const storage = {
    openRead: vi.fn(async (key: string) => {
      events.push(`open ${key}`)
      return Readable.from([Buffer.from("x")])
    }),
    uploadStream: vi.fn(() => {
      const stream = new PassThrough()
      let size = 0
      const done = new Promise<number>((resolve, reject) => {
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length
          if (options.uploadFails === true && size > 2_000) stream.destroy(new Error("storage went away"))
        })
        stream.on("end", () => resolve(size))
        stream.on("error", reject)
      })
      return { stream, done }
    }),
    remove: vi.fn(async () => undefined),
  }
  const builder = new ExportBuilder(
    reader as unknown as ExportReaderRepository,
    storage as unknown as StorageService,
    { transaction: async (fn: () => Promise<unknown>) => fn() } as unknown as PrismaService,
  )
  return { builder, reader, storage, events }
}

const build = (h: ReturnType<typeof harness>) => h.builder.build("o-1", "x-1", { name: "Acme", slug: "acme" }, new Date(0))

describe("ExportBuilder", () => {
  it("lists the files a page at a time, reading the next only once the zip has reached the last", async () => {
    const h = harness(EXPORT_PAGE * 2 + 1)
    const { sizeBytes } = await build(h)
    expect(sizeBytes).toBeGreaterThan(0)
    expect(h.reader.attachments).toHaveBeenCalledTimes(3)
    const second = h.events.indexOf(`page from ${String(EXPORT_PAGE)}`)
    expect(h.events.indexOf(`open k-${String(EXPORT_PAGE - 1)}`)).toBeLessThan(second)
    expect(h.events.indexOf(`open k-${String(EXPORT_PAGE)}`)).toBeGreaterThan(second)
    expect(h.storage.openRead).toHaveBeenCalledTimes(EXPORT_PAGE * 2 + 1)
  })

  it("stops, removes what it wrote and fails when the upload fails mid-way", async () => {
    const h = harness(EXPORT_PAGE * 2, { uploadFails: true })
    await expect(build(h)).rejects.toThrow("storage went away")
    expect(h.storage.remove).toHaveBeenCalledWith("org/o-1/exports/x-1.zip")
  })

  it("fails, and removes what it stored, when the upload fails — it never waits for a drain that will not come", async () => {
    const remove = vi.fn(async () => undefined)
    const reader = {
      readers: [
        {
          file: "tickets",
          read: async () => ({ rows: Array.from({ length: 50 }, (_, i) => ({ id: String(i), body: "x".repeat(2000) })), next: null }),
        },
      ],
      attachments: async () => [],
    } as unknown as ExportReaderRepository
    const storage = {
      // Nobody reads the stream, and the upload gives up: the classic hang.
      uploadStream: () => ({ stream: new PassThrough({ highWaterMark: 16 }), done: Promise.reject(new Error("part upload failed")) }),
      remove,
    } as unknown as StorageService
    const prisma = { transaction: async <T>(fn: () => Promise<T>) => fn() } as unknown as PrismaService
    await expect(
      new ExportBuilder(reader, storage, prisma).build("o-1", "x-1", { name: "Acme", slug: "acme" }, new Date(0)),
    ).rejects.toThrow("part upload failed")
    expect(remove).toHaveBeenCalledWith("org/o-1/exports/x-1.zip")
  })

  it("names files safely inside the archive", () => {
    expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd")
    expect(safeName("a\u0000b\nc.txt")).toBe("abc.txt")
    expect(safeName("...")).toBe("file")
  })
})
