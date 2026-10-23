import { lookup as dnsLookup, type LookupAddress } from "node:dns"
import http from "node:http"
import https from "node:https"
import { BlockList, isIP, type LookupFunction } from "node:net"

/**
 * Outbound requests to addresses a tenant chose: webhook receivers (ADR-0050)
 * and identity providers (ADR-0054). Every address the host resolves to is
 * checked inside the connection's own `lookup`, so the address that was vetted
 * is the address that is dialled; checking a name and then letting a client
 * resolve it again is the DNS-rebinding hole.
 */

/** Ranges no webhook may reach: this host, private networks, link-local (cloud metadata), and the reserved. */
const BLOCKED = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4")
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  // Documentation, RFC 9637: inside global unicast, so the allow-list alone would let it through.
  ["3fff::", 20],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6")
}

/** IPv4 carried inside IPv6: mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::a.b.c.d`). Checked as the IPv4 it is. */
function embeddedIpv4(address: string): string | null {
  const dotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (dotted?.[1] !== undefined) return dotted[1]
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
  if (hex?.[1] === undefined || hex[2] === undefined) return null
  const high = Number.parseInt(hex[1], 16)
  const low = Number.parseInt(hex[2], 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join(".")
}

/** The only IPv6 a webhook may reach: global unicast. Everything outside it is local, reserved or a transition form. */
const GLOBAL_UNICAST = new BlockList()
GLOBAL_UNICAST.addSubnet("2000::", 3, "ipv6")

/**
 * Whether an IP address is one a webhook may never reach. Anything
 * unparseable is blocked. IPv6 is an allow-list, not a deny-list: IPv4 carried
 * in a mapped or well-known NAT64 address is judged as that IPv4, and
 * otherwise only global unicast passes, less its reserved blocks. The
 * deprecated compatible form (`::a.b.c.d`), SIIT (`::ffff:0:a.b.c.d`) and
 * local-use NAT64 (`64:ff9b:1::/48`) all fall outside it.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return BLOCKED.check(address, "ipv4")
  if (family !== 6) return true
  const v4 = embeddedIpv4(address)
  if (v4 !== null) return isBlockedAddress(v4)
  return !GLOBAL_UNICAST.check(address, "ipv6") || BLOCKED.check(address, "ipv6")
}

/**
 * A target refused. The message is safe to show the tenant; `detail` names the
 * address and is for the server's log only, or the delivery log would map
 * internal host names to private addresses for anyone who asks (ADR-0050).
 */
export class BlockedTargetError extends Error {
  constructor(
    reason: string,
    readonly detail: string = reason,
  ) {
    super(`webhook target refused: ${reason}`)
  }
}

/**
 * What can be said of a URL without resolving it, at save time and again
 * before each attempt: https, no credentials, and no blocked IP literal or
 * `localhost`. `allowPrivate` is local development's receiver on this machine.
 */
export function checkTarget(url: string, allowPrivate: boolean): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new BlockedTargetError("not a URL")
  }
  if (parsed.protocol !== "https:" && !(allowPrivate && parsed.protocol === "http:")) throw new BlockedTargetError("must be https")
  if (parsed.username !== "" || parsed.password !== "") throw new BlockedTargetError("carries credentials")
  if (allowPrivate) return parsed
  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost")) throw new BlockedTargetError("names this host")
  if (isIP(host) !== 0 && isBlockedAddress(host)) throw new BlockedTargetError(`${host} is a private or reserved address`)
  return parsed
}

/** A `lookup` that resolves as usual and refuses if any address is blocked — all of them, not the first. */
export function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error !== null) {
        callback(error, "", 0)
        return
      }
      const blocked = allowPrivate ? undefined : addresses.find((a) => isBlockedAddress(a.address))
      if (blocked !== undefined) {
        callback(new BlockedTargetError("the host resolves to a private or reserved address", `${hostname} resolves to ${blocked.address}`), "", 0)
        return
      }
      if (options.all === true) {
        ;(callback as unknown as (e: null, addresses: LookupAddress[]) => void)(null, addresses)
        return
      }
      const first = addresses[0]
      if (first === undefined) callback(new BlockedTargetError("the host resolves to nothing", `${hostname} resolves to nothing`), "", 0)
      else callback(null, first.address, first.family)
    })
  }
}

export type SafeResponse = { status: number; body: string; durationMs: number; headers: Headers }

export type SafeRequestOptions = {
  headers: Record<string, string>
  timeoutMs: number
  /** Response bytes kept; the rest is read and dropped. */
  maxBodyBytes: number
  allowPrivate: boolean
}

/**
 * What a failed attempt says in the delivery log: the kind of failure, never
 * an address or a resolver's words. The full error goes to the server's log.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof BlockedTargetError) return error.message
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : ""
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return "could not resolve the host"
  if (code === "ECONNREFUSED") return "connection refused"
  if (code === "ECONNRESET" || code === "EPIPE") return "connection reset"
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "host unreachable"
  if (/CERT|TLS|SSL|SELF_SIGNED|DEPTH_ZERO/.test(code)) return "the TLS certificate was not accepted"
  if (error instanceof Error && error.message.startsWith("timed out")) return error.message
  return "the request failed"
}

/**
 * POSTs `body` to `url` without following redirects (a redirect is a second,
 * unvetted address), within `timeoutMs` end to end. Resolves with any HTTP
 * status; rejects for a refused target, a network error or the timeout.
 */
export function postSafely(url: string, body: string, options: SafeRequestOptions): Promise<SafeResponse> {
  return requestSafely("POST", url, body, { ...options, headers: { ...options.headers, "content-type": "application/json" } })
}

/** Any method, the same rules: vetted addresses, no redirects, a deadline, a bounded body. */
export function requestSafely(method: string, url: string, body: string | Buffer | null, options: SafeRequestOptions): Promise<SafeResponse> {
  const target = checkTarget(url, options.allowPrivate)
  const transport = target.protocol === "https:" ? https : http
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method,
        headers: { ...options.headers, ...(body === null ? {} : { "content-length": String(Buffer.byteLength(body)) }) },
        lookup: guardedLookup(options.allowPrivate),
        // No connection reuse: each attempt resolves and is vetted afresh.
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        let kept = 0
        response.on("data", (chunk: Buffer) => {
          if (kept >= options.maxBodyBytes) return
          const slice = chunk.subarray(0, options.maxBodyBytes - kept)
          chunks.push(slice)
          kept += slice.length
        })
        response.on("end", () => {
          clearTimeout(timer)
          const headers = new Headers()
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") headers.set(name, value)
            else if (Array.isArray(value)) for (const one of value) headers.append(name, one)
          }
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), durationMs: Math.round(performance.now() - started), headers })
        })
        response.on("error", (error) => {
          clearTimeout(timer)
          reject(error)
        })
      },
    )
    const timer = setTimeout(() => request.destroy(new Error(`timed out after ${String(options.timeoutMs)} ms`)), options.timeoutMs)
    request.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    if (body === null) request.end()
    else request.end(body)
  })
}
