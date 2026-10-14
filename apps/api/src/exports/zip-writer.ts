import { Zip, ZipDeflate, ZipPassThrough } from "fflate"
import { once } from "node:events"
import type { PassThrough } from "node:stream"

/** One file inside the archive, written a chunk at a time. */
export type ZipEntry = { write: (bytes: Uint8Array) => Promise<void>; end: () => Promise<void> }

/**
 * fflate's streaming zip onto a Node stream, with backpressure: fflate calls
 * back synchronously, so after every push the writer waits for the output to
 * drain before handing it more. The archive is never more than the stream's
 * buffer ahead of the upload behind it. Entries are written one at a time.
 */
export class ZipWriter {
  private readonly zip: Zip
  private failure: Error | null = null

  constructor(private readonly out: PassThrough) {
    this.zip = new Zip((error, chunk, final) => {
      if (error !== null) {
        this.failure = error
        out.destroy(error)
        return
      }
      out.write(chunk)
      if (final) out.end()
    })
  }

  /** Text and JSON compress well; files are mostly compressed already and are stored as they are. */
  entry(name: string, compress: boolean): ZipEntry {
    const file = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
    this.zip.add(file)
    return {
      write: async (bytes) => {
        file.push(bytes)
        await this.drained()
      },
      end: async () => {
        file.push(new Uint8Array(0), true)
        await this.drained()
      },
    }
  }

  end(): void {
    this.zip.end()
  }

  private async drained(): Promise<void> {
    if (this.failure !== null) throw this.failure
    // `once` rejects if the stream errors meanwhile — a failed upload destroys it.
    if (this.out.writableNeedDrain) await once(this.out, "drain")
  }
}
