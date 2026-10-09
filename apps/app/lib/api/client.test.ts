import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { clientApi } from "./client"
import { ApiError } from "./errors"

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
const status = (code: number, body: unknown = null) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/problem+json" },
  })

let assign: ReturnType<typeof vi.fn>

beforeEach(() => {
  assign = vi.fn()
  vi.stubGlobal("location", {
    host: "acme.lvh.me:3001",
    href: "http://acme.lvh.me:3001/tickets",
    assign,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("clientApi", () => {
  it("sends credentials and the CSRF header, and parses the answer with the contract", async () => {
    const fetchMock = vi.fn(async () => okJson({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      clientApi("/me", { schema: z.object({ ok: z.boolean() }) })
    ).resolves.toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe("http://api.lvh.me:4000/api/v1/me")
    expect(init.credentials).toBe("include")
    expect(new Headers(init.headers).get("X-Requested-With")).toBe("patchgrid")
  })

  it("refreshes once on a 401 and retries once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(status(401))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(okJson({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      clientApi("/me", { schema: z.object({ ok: z.boolean() }) })
    ).resolves.toEqual({ ok: true })
    const refreshCall = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ]
    expect(refreshCall[0]).toBe("http://api.lvh.me:4000/api/v1/auth/refresh")
    expect(refreshCall[1].body).toBe(JSON.stringify({ slug: "acme" }))
  })

  it("shares one refresh between concurrent 401s — two rotations would look like theft", async () => {
    let refreshes = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) {
        refreshes += 1
        await new Promise((r) => setTimeout(r, 5))
        return new Response(null, { status: 204 })
      }
      return refreshes === 0 ? status(401) : okJson({ ok: true })
    })
    vi.stubGlobal("fetch", fetchMock)
    const schema = z.object({ ok: z.boolean() })
    await Promise.all([
      clientApi("/a", { schema }),
      clientApi("/b", { schema }),
      clientApi("/c", { schema }),
    ])
    expect(refreshes).toBe(1)
  })

  it("goes to login when the refresh fails, with the way back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => status(401))
    )
    void clientApi("/me", { schema: null })
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce())
    expect(assign.mock.calls[0]?.[0]).toBe(
      `http://app.lvh.me:3001/login?next=${encodeURIComponent("http://acme.lvh.me:3001/tickets")}`
    )
  })

  it("turns a problem into an ApiError that names its type and its field errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        status(400, {
          type: "https://patchgrid.xyz/problems/validation-failed",
          title: "Validation failed",
          status: 400,
          errors: [
            {
              path: "email",
              message: "must be an email address",
              code: "invalid_format",
            },
          ],
        })
      )
    )
    const error = await clientApi("/invitations", {
      method: "POST",
      body: {},
      schema: null,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).type).toBe("validation-failed")
    expect((error as ApiError).fieldError("email")).toBe(
      "must be an email address"
    )
  })
})

describe("clientApi — anonymous calls", () => {
  it("returns a 401 as the answer, without refreshing or leaving the page", async () => {
    const fetchMock = vi.fn(async () =>
      status(401, {
        type: "https://patchgrid.xyz/problems/not-authenticated",
        title: "Not authenticated",
        status: 401,
      })
    )
    vi.stubGlobal("fetch", fetchMock)
    const error = await clientApi("/auth/login", {
      method: "POST",
      body: {},
      schema: null,
      anonymous: true,
    }).catch((e: unknown) => e)
    expect((error as ApiError).status).toBe(401)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(assign).not.toHaveBeenCalled()
  })
})
