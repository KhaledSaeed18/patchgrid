import { Injectable } from "@nestjs/common"
import { EXPORT_FORMAT_VERSION } from "@patchgrid/contracts"
import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { ZipFile } from "yazl"

import { PrismaService } from "../prisma/prisma.service"
import { StorageService } from "../storage/storage.service"
import { EXPORT_PAGE, type ExportAttachment, ExportReaderRepository } from "./repositories/export-reader.repository"

/**
 * Builds one export's zip (ADR-0044), streamed into storage as it is made,
 * inside `runAsTenant` for the org it names. Every entity is a newline-
 * delimited JSON file; every uploaded file follows under `attachments/`, its
 * SHA-256 taken on the way through; `manifest.json` closes the archive with
 * what is in it.
 *
 * yazl writes the archive one entry at a time and pulls each entry's stream
 * only when it gets to it, so a page is read when the zip needs it and an
 * attachment is opened when its turn comes. It uses ZIP64 wherever the
 * sizes or the entry count need it. The output is piped into the upload, so
 * backpressure is the stream's own, and a failed upload rejects the pipeline
 * instead of leaving a writer waiting for a drain that never comes.
 */
@Injectable()
export class ExportBuilder {
  constructor(
    private readonly reader: ExportReaderRepository,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  async build(
    orgId: string,
    exportId: string,
    org: { name: string; slug: string },
    takenAt: Date,
  ): Promise<{ storageKey: string; sizeBytes: number }> {
    const storageKey = `org/${orgId}/exports/${exportId}.zip`
    const zip = new ZipFile()
    const counts: Record<string, number> = {}

    for (const reader of this.reader.readers) {
      const file = `${reader.file}.ndjson`
      const prisma = this.prisma
      zip.addReadStream(
        Readable.from(
          (async function* () {
            let after: string | null = null
            let rows = 0
            do {
              const page = await prisma.transaction(() => reader.read(orgId, after))
              for (const row of page.rows) yield `${JSON.stringify(row, plain)}\n`
              rows += page.rows.length
              after = page.next
            } while (after !== null)
            counts[file] = rows
          })(),
        ),
        file,
      )
    }

    // The files' list is read up front — a row per file, not its bytes — so each gets its entry.
    const attachments: ExportAttachment[] = []
    let after: string | null = null
    do {
      const page = await this.prisma.transaction(() => this.reader.attachments(orgId, after))
      attachments.push(...page)
      after = page.length === EXPORT_PAGE ? (page.at(-1)?.id ?? null) : null
    } while (after !== null)

    const manifest: string[] = []
    for (const { storageKey: key, ...attachment } of attachments) {
      const path = `attachments/${attachment.id}/${safeName(attachment.filename)}`
      const storage = this.storage
      zip.addReadStream(
        Readable.from(
          (async function* () {
            const body = await storage.openRead(key)
            if (body === null) {
              manifest.push(`${JSON.stringify({ ...attachment, path: null, missing: true }, plain)}\n`)
              return
            }
            const hash = createHash("sha256")
            for await (const chunk of body) {
              const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk))
              hash.update(bytes)
              yield bytes
            }
            manifest.push(`${JSON.stringify({ ...attachment, path, sha256: hash.digest("hex") }, plain)}\n`)
          })(),
        ),
        path,
        { compress: false },
      )
    }

    // Entries are written in order, so by the time these are read every file above has been streamed.
    zip.addReadStream(
      Readable.from(
        (async function* () {
          yield* manifest
        })(),
      ),
      "attachments.ndjson",
    )
    zip.addReadStream(
      Readable.from(
        (async function* () {
          counts["attachments.ndjson"] = manifest.length
          yield JSON.stringify(
            { format: "patchgrid-export", version: EXPORT_FORMAT_VERSION, workspace: org, takenAt: takenAt.toISOString(), files: counts },
            null,
            2,
          )
        })(),
      ),
      "manifest.json",
    )
    zip.end()

    const { stream, done } = this.storage.uploadStream(storageKey, "application/zip")
    try {
      const [, sizeBytes] = await Promise.all([pipeline(zip.outputStream, stream), done])
      return { storageKey, sizeBytes }
    } catch (error) {
      // `pipeline` has already destroyed both ends.
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
