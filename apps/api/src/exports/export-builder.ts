import { Injectable } from "@nestjs/common"
import { EXPORT_FORMAT_VERSION } from "@patchgrid/contracts"
import { createHash } from "node:crypto"

import { PrismaService } from "../prisma/prisma.service"
import { StorageService } from "../storage/storage.service"
import { EXPORT_PAGE, ExportReaderRepository } from "./repositories/export-reader.repository"
import { ZipWriter } from "./zip-writer"

const encoder = new TextEncoder()

/**
 * Builds one export's zip (ADR-0044), streamed into storage as it is made,
 * inside `runAsTenant` for the org it names. Every entity is a newline-
 * delimited JSON file; every uploaded file follows under `attachments/`, its
 * SHA-256 taken on the way through; `manifest.json` closes the archive with
 * what is in it. Nothing larger than one page, or one chunk of one file, is
 * ever in memory.
 */
@Injectable()
export class ExportBuilder {
  constructor(
    private readonly reader: ExportReaderRepository,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  async build(orgId: string, exportId: string, org: { name: string; slug: string }, takenAt: Date): Promise<{ storageKey: string; sizeBytes: number }> {
    const storageKey = `org/${orgId}/exports/${exportId}.zip`
    const { stream, done } = this.storage.uploadStream(storageKey, "application/zip")
    // A failed upload must stop the writer, not leave it waiting for a drain.
    done.catch((error: unknown) => stream.destroy(error instanceof Error ? error : new Error(String(error))))
    const zip = new ZipWriter(stream)
    const counts: Record<string, number> = {}
    try {
      for (const reader of this.reader.readers) {
        const file = zip.entry(`${reader.file}.ndjson`, true)
        let after: string | null = null
        let rows = 0
        do {
          const page = await this.prisma.transaction(() => reader.read(orgId, after))
          for (const row of page.rows) await file.write(encoder.encode(`${JSON.stringify(row, plain)}\n`))
          rows += page.rows.length
          after = page.next
        } while (after !== null)
        await file.end()
        counts[`${reader.file}.ndjson`] = rows
      }

      const manifest = zip.entry("attachments.ndjson", true)
      let after: string | null = null
      let files = 0
      do {
        const page = await this.prisma.transaction(() => this.reader.attachments(orgId, after))
        for (const { storageKey: key, ...attachment } of page) {
          const body = await this.storage.openRead(key)
          if (body === null) {
            await manifest.write(encoder.encode(`${JSON.stringify({ ...attachment, path: null, missing: true }, plain)}\n`))
            continue
          }
          const path = `attachments/${attachment.id}/${safeName(attachment.filename)}`
          const entry = zip.entry(path, false)
          const hash = createHash("sha256")
          for await (const chunk of body) {
            const bytes = chunk instanceof Uint8Array ? chunk : encoder.encode(String(chunk))
            hash.update(bytes)
            await entry.write(bytes)
          }
          await entry.end()
          files += 1
          await manifest.write(encoder.encode(`${JSON.stringify({ ...attachment, path, sha256: hash.digest("hex") }, plain)}\n`))
        }
        after = page.length === EXPORT_PAGE ? (page.at(-1)?.id ?? null) : null
      } while (after !== null)
      await manifest.end()
      counts["attachments.ndjson"] = files

      const summary = zip.entry("manifest.json", true)
      await summary.write(
        encoder.encode(JSON.stringify({ format: "patchgrid-export", version: EXPORT_FORMAT_VERSION, workspace: org, takenAt: takenAt.toISOString(), files: counts }, null, 2)),
      )
      await summary.end()
      zip.end()
      return { storageKey, sizeBytes: await done }
    } catch (error) {
      stream.destroy()
      await done.catch(() => undefined)
      await this.storage.remove(storageKey).catch(() => undefined)
      throw error
    }
  }
}

/** JSON as the archive writes it: big integers as strings, everything else as `JSON.stringify` would. */
function plain(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

/** A filename safe inside a zip path: no folders, no control characters, never empty. */
export function safeName(filename: string): string {
  const printable = [...filename].filter((c) => (c.codePointAt(0) ?? 0) >= 0x20 && c !== "\u007f").join("")
  const cleaned = printable.replace(/[/\\]/g, "_").replace(/^\.+/, "").trim()
  return cleaned === "" ? "file" : cleaned.slice(0, 200)
}
