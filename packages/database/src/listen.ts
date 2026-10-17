import { Client } from "pg"

/** The channel `outbox_wake()` notifies on commit, with the org id as payload (ADR-0049). */
export const OUTBOX_CHANNEL = "patchgrid_outbox"

export type Listener = {
  /** Stops listening and closes the connection; no reconnect follows. */
  close(): Promise<void>
}

export type ListenOptions = {
  connectionString: string
  channel: string
  onNotify: (payload: string) => void
  /** Called once per (re)connection, after LISTEN took effect: anything committed while disconnected was missed. */
  onConnect?: () => void
  onError?: (error: Error) => void
  /** Delay before reconnecting after a lost connection. */
  retryMs?: number
}

/**
 * One dedicated connection holding `LISTEN` (ADR-0049). It cannot come from the
 * pool: a pooled connection returns to the pool between queries, and a
 * notification is delivered only to the session that is listening.
 *
 * A notification sent while nobody listens is lost, not queued, so every
 * (re)connection calls `onConnect`, and the caller treats that as "something
 * may have been missed". The sweep is the backstop for a gap shorter than that.
 */
export async function listen(options: ListenOptions): Promise<Listener> {
  const retryMs = options.retryMs ?? 1_000
  if (!/^[a-z_][a-z0-9_]*$/.test(options.channel)) {
    throw new Error(`Refusing to listen on ${JSON.stringify(options.channel)}`)
  }
  let closed = false
  let client: Client | null = null
  let timer: NodeJS.Timeout | null = null

  const reconnect = () => {
    if (closed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void connect()
    }, retryMs)
  }

  const connect = async (): Promise<void> => {
    const next = new Client({ connectionString: options.connectionString })
    next.on("notification", (message) => {
      if (message.channel === options.channel && message.payload !== undefined) options.onNotify(message.payload)
    })
    next.on("error", (error) => {
      options.onError?.(error)
      next.removeAllListeners("end")
      void next.end().catch(() => undefined)
      if (client === next) client = null
      reconnect()
    })
    next.on("end", () => {
      if (client === next) client = null
      reconnect()
    })
    try {
      await next.connect()
      await next.query(`LISTEN ${options.channel}`)
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)))
      next.removeAllListeners("end")
      await next.end().catch(() => undefined)
      reconnect()
      return
    }
    if (closed) {
      await next.end().catch(() => undefined)
      return
    }
    client = next
    options.onConnect?.()
  }

  await connect()

  return {
    async close() {
      closed = true
      if (timer !== null) clearTimeout(timer)
      const current = client
      client = null
      if (current !== null) {
        current.removeAllListeners("end")
        await current.end().catch(() => undefined)
      }
    },
  }
}
