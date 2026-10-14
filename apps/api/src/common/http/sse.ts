import type { Response } from "express"
import type { Observable } from "rxjs"

/** A server-sent event, or a comment line. */
export type SseFrame = { event: string; id?: string; data: unknown } | { comment: string }

/** How long a browser waits before reconnecting after the server ends a stream. */
const RETRY_MS = 3_000
/** A client this far behind is not reading; the stream ends rather than buffer for it. */
const MAX_BUFFERED_BYTES = 1_000_000

/** One frame in the wire format (HTML §9.2): fields, then a blank line. Data is JSON, so never multi-line. */
export function encodeFrame(frame: SseFrame): string {
  if ("comment" in frame) return `: ${frame.comment.replace(/[\r\n]/g, " ")}\n\n`
  const id = frame.id === undefined ? "" : `id: ${frame.id}\n`
  return `event: ${frame.event}\n${id}data: ${JSON.stringify(frame.data)}\n\n`
}

/**
 * Writes an observable of frames to the response as `text/event-stream`, and
 * tears both down together: the server completing ends the response, the
 * client going away unsubscribes. Transport only — what a stream says, and to
 * whom, is decided before the observable reaches here.
 */
export function writeEventStream(response: Response, frames: Observable<SseFrame>): void {
  response.status(200)
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8")
  response.setHeader("Cache-Control", "no-cache, no-transform")
  response.setHeader("Connection", "keep-alive")
  // nginx and friends buffer responses unless told not to.
  response.setHeader("X-Accel-Buffering", "no")
  response.flushHeaders()
  response.write(`retry: ${String(RETRY_MS)}\n: open\n\n`)

  const end = () => {
    if (!response.writableEnded) response.end()
  }
  const subscription = frames.subscribe({
    next: (frame) => {
      if (response.writableEnded) return
      response.write(encodeFrame(frame))
      if (response.writableLength > MAX_BUFFERED_BYTES) subscription.unsubscribe()
    },
    error: end,
    complete: end,
  })
  // The response's close is the disconnect: the request's can fire early once its body is read.
  response.on("close", () => subscription.unsubscribe())
  subscription.add(end)
}
