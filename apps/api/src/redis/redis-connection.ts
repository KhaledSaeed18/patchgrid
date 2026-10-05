/**
 * BullMQ takes ioredis options, not a URL. One parser, so the queue and the
 * cache client cannot disagree about which Redis they talk to.
 */
export type RedisConnectionOptions = {
  host: string
  port: number
  username?: string
  password?: string
  db?: number
  tls?: Record<string, never>
}

export function redisConnectionOptions(redisUrl: string): RedisConnectionOptions {
  const url = new URL(redisUrl)
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`REDIS_URL must be redis:// or rediss://, got ${url.protocol}`)
  }
  const options: RedisConnectionOptions = {
    host: url.hostname,
    port: url.port === "" ? 6379 : Number(url.port),
  }
  if (url.username !== "") options.username = decodeURIComponent(url.username)
  if (url.password !== "") options.password = decodeURIComponent(url.password)
  const db = url.pathname.replace(/^\//, "")
  if (db !== "") options.db = Number(db)
  if (url.protocol === "rediss:") options.tls = {}
  return options
}
