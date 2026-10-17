import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { BlockedTargetError, checkTarget, isBlockedAddress, postSafely } from "./safe-request"

describe("isBlockedAddress", () => {
  it("blocks this host, private networks, link-local and the metadata address, in both families", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isBlockedAddress(address), address).toBe(true)
    }
  })

  it("sees through IPv4 inside IPv6, mapped or NAT64, dotted or hex", () => {
    for (const address of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::10.0.0.1", "::ffff:a9fe:a9fe"]) {
      expect(isBlockedAddress(address), address).toBe(true)
    }
    expect(isBlockedAddress("::ffff:93.184.216.34")).toBe(false)
  })

  it("lets public addresses through, and blocks what does not parse", () => {
    for (const address of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) {
      expect(isBlockedAddress(address), address).toBe(false)
    }
    expect(isBlockedAddress("not-an-ip")).toBe(true)
  })
})

describe("checkTarget", () => {
  it("wants https, no credentials, and no private literal or localhost", () => {
    expect(checkTarget("https://hooks.example.com/x", false).hostname).toBe("hooks.example.com")
    for (const url of ["http://hooks.example.com/", "https://u:p@hooks.example.com/", "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://a.localhost/", "https://169.254.169.254/latest/meta-data", "ftp://x/"]) {
      expect(() => checkTarget(url, false), url).toThrow(BlockedTargetError)
    }
  })

  it("allows a local receiver over http only when told to, still without credentials", () => {
    expect(checkTarget("http://127.0.0.1:9999/hook", true).port).toBe("9999")
    expect(() => checkTarget("http://u:p@127.0.0.1/", true)).toThrow(BlockedTargetError)
  })
})

describe("postSafely", () => {
  let server: Server
  let base = ""
  const seen: { headers: Record<string, unknown>; body: string }[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ""
      req.on("data", (c: Buffer) => (body += c.toString()))
      req.on("end", () => {
        seen.push({ headers: req.headers, body })
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "http://169.254.169.254/" }).end()
        } else if (req.url === "/slow") {
          setTimeout(() => res.writeHead(200).end("late"), 500)
        } else {
          res.writeHead(200).end("x".repeat(10_000))
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const options = { headers: { "webhook-id": "d-1" }, timeoutMs: 2_000, maxBodyBytes: 1_024, allowPrivate: true }

  it("posts the body with its headers and keeps only the first bytes of the answer", async () => {
    const response = await postSafely(`${base}/ok`, '{"a":1}', options)
    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(1_024)
    expect(seen.at(-1)).toMatchObject({ body: '{"a":1}', headers: expect.objectContaining({ "webhook-id": "d-1", "content-type": "application/json" }) })
  })

  it("never follows a redirect: a 3xx is the answer", async () => {
    expect((await postSafely(`${base}/redirect`, "{}", options)).status).toBe(302)
  })

  it("gives up at the timeout", async () => {
    await expect(postSafely(`${base}/slow`, "{}", { ...options, timeoutMs: 100 })).rejects.toThrow(/timed out/)
  })

  it("refuses a name that resolves to this host when private targets are not allowed", async () => {
    // `localtest.me`-style names cannot be relied on offline; a resolver answer of 127.0.0.1 is what matters.
    await expect(postSafely(`https://localhost.:1/`, "{}", { ...options, allowPrivate: false })).rejects.toThrow(BlockedTargetError)
  })
})
