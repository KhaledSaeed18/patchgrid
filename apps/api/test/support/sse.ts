/**
 * A browser's `EventSource`, for specs: opens `GET /notifications/stream`
 * with the workspace's Origin and access cookie, parses frames as they
 * arrive, and lets a spec await the next frame matching a predicate. Nothing
 * here sleeps — `next` resolves on data. Proving that a frame did NOT arrive
 * is done with a sentinel: cause an event the stream must receive after the
 * one it must not, and assert the sentinel is the first to arrive.
 */
import type { INestApplication } from "@nestjs/common"
import http from "node:http"
import type { AddressInfo } from "node:net"

export type Frame = { event: string; id: string | null; data: unknown }

export type Stream = {
  status: number
  frames: Frame[]
  /** Resolves with the first frame, from now on or already buffered and unclaimed, that matches. */
  next: (match?: (frame: Frame) => boolean) => Promise<Frame>
  /** Resolves when the server ends the stream. */
  ended: Promise<void>
  close: () => void
}

export async function openStream(
  app: INestApplication,
  origin: string,
  access: string,
  headers: Record<string, string> = {},
): Promise<Stream> {
  const { port } = (app.getHttpServer() as http.Server).address() as AddressInfo
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/v1/notifications/stream", headers: { Origin: origin, Cookie: access, ...headers } },
      (res) => {
        const frames: Frame[] = []
        let claimed = 0
        const waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = []
        let buffer = ""
        let endResolve: () => void = () => undefined
        const ended = new Promise<void>((r) => (endResolve = r))

        const offer = () => {
          while (claimed < frames.length) {
            const frame = frames[claimed] as Frame
            const i = waiters.findIndex((w) => w.match(frame))
            if (i === -1) {
              if (waiters.length === 0) return
              claimed += 1
              continue
            }
            const [w] = waiters.splice(i, 1)
            claimed += 1
            w?.resolve(frame)
          }
        }
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          buffer += chunk
          let cut = buffer.indexOf("\n\n")
          while (cut !== -1) {
            const block = buffer.slice(0, cut)
            buffer = buffer.slice(cut + 2)
            cut = buffer.indexOf("\n\n")
            const fields = new Map<string, string>()
            for (const line of block.split("\n")) {
              if (line.startsWith(":") || line === "") continue
              const at = line.indexOf(":")
              fields.set(line.slice(0, at), line.slice(at + 1).trimStart())
            }
            const event = fields.get("event")
            const data = fields.get("data")
            if (event === undefined || data === undefined) continue
            frames.push({ event, id: fields.get("id") ?? null, data: JSON.parse(data) as unknown })
          }
          offer()
        })
        res.on("end", () => endResolve())
        res.on("close", () => endResolve())

        resolve({
          status: res.statusCode ?? 0,
          frames,
          next: (match = () => true) =>
            new Promise<Frame>((r) => {
              waiters.push({ match, resolve: r })
              offer()
            }),
          ended,
          close: () => req.destroy(),
        })
      },
    )
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error)
    })
    req.end()
  })
}
