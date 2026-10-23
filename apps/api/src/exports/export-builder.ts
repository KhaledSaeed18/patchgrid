import { Injectable } from "@nestjs/common"
import { EXPORT_FORMAT_VERSION } from "@patchgrid/contracts"
import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { ZipFile } from "yazl"

import { PrismaService } from "../prisma/prisma.service"
import { StorageService } from "../storage/storage.service"
import { EXPORT_PAGE, ExportReaderRepository } from "./repositories/export-reader.repository"

/**
 * Builds one export's zip (ADR-0044), streamed into storage as it is made,
 * inside `runAsTenant` for the org it names. Every entity is a newline-
 * delimited JSON file; every uploaded file follows under `attachments/`, its
 * SHA-256 taken on the way through; `manifest.json` closes the archive with
 * what is in it.
 *
 * yazl writes the archive one entry at a time and pulls each entry's stream
 * only when it gets to it, so a page is read when the zip needs it and an
 * attachment is opened when its turn comes. The files themselves are listed
 * a page at a time too, the next page once the zip has written the last. It uses ZIP64 wherever the
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

    // The upload runs from here on: the files below are listed a page at a time, as the zip reaches them.
    const { stream, done } = this.storage.uploadStream(storageKey, "application/zip")
    const upload = Promise.all([pipeline(zip.outputStream, stream), done]).then(([, sizeBytes]) => sizeBytes)
    // Settled the moment the upload fails, so a page waiting on the zip never waits for ever.
    const failed = upload.then(
      () => new Promise<never>(() => undefined),
      (error: unknown) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
    )
    // Its rejection is seen through `upload`; this copy only ends a wait.
    failed.catch(() => undefined)

    const manifest: string[] = []
    try {
      let after: string | null = null
      do {
        const page = await this.prisma.transaction(() => this.reader.attachments(orgId, after))
        let pageStreamed = (): void => undefined
        const streamed = new Promise<void>((resolve) => (pageStreamed = resolve))
        for (const [i, { storageKey: key, ...attachment }] of page.entries()) {
          const path = `attachments/${attachment.id}/${safeName(attachment.filename)}`
          const storage = this.storage
          const last = i === page.length - 1
          zip.addReadStream(
            Readable.from(
              (async function* () {
                try {
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
                } finally {
                  if (last) pageStreamed()
                }
              })(),
            ),
            path,
            { compress: false },
          )
        }
        after = page.length === EXPORT_PAGE ? (page.at(-1)?.id ?? null) : null
        // The next page is read once the zip has written this one: one page of rows in memory, never the list.
        if (page.length > 0 && after !== null) await Promise.race([streamed, failed])
      } while (after !== null)
    } catch (error) {
      zip.end()
      stream.destroy()
      await done.catch(() => undefined)
      await this.storage.remove(storageKey).catch(() => undefined)
      throw error
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

    try {
      return { storageKey, sizeBytes: await upload }
    } catch (error) {
      // Ends the pipeline too, whichever side failed first.
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
