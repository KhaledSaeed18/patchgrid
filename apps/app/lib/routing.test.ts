// @vitest-environment node
import { describe, expect, it } from "vitest"

import { parseHost } from "./host"
import { decideRoute, type RouteInput } from "./routing"
import { needsRefresh, tokenExpiresAt } from "./session"

const NOW = 1_800_000_000
const APP = "http://app.lvh.me:3001"

/** An unsigned token with the given expiry — the proxy never verifies, only reads. */
const token = (exp: number) => `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.y`

function route(host: string, path: string, cookies: Record<string, string> = {}) {
  const [pathname = "/", query] = path.split("?")
  const input: RouteInput = {
    host,
    origin: `http://${host}`,
    pathname,
    search: query === undefined ? "" : `?${query}`,
    cookies: (name) => cookies[name],
    nowSeconds: NOW,
    rootDomain: "lvh.me",
    appOrigin: APP,
  }
  return decideRoute(input)
}

describe("parseHost", () => {
  it("knows app., a workspace, and what is not ours", () => {
    expect(parseHost("app.lvh.me:3001", "lvh.me")).toEqual({ kind: "app" })
    expect(parseHost("ACME.lvh.me:3001", "lvh.me")).toEqual({ kind: "tenant", slug: "acme" })
    expect(parseHost("api.lvh.me", "lvh.me")).toEqual({ kind: "foreign" })
    expect(parseHost("a.b.lvh.me", "lvh.me")).toEqual({ kind: "foreign" })
    expect(parseHost("lvh.me:3000", "lvh.me")).toEqual({ kind: "foreign" })
    expect(parseHost("acme.evil.test", "lvh.me")).toEqual({ kind: "foreign" })
    expect(parseHost(null, "lvh.me")).toEqual({ kind: "foreign" })
  })
})

describe("token expiry", () => {
  it("reads exp, and treats anything unreadable as needing a refresh", () => {
    expect(tokenExpiresAt(token(NOW + 600))).toBe(NOW + 600)
    expect(tokenExpiresAt("not-a-jwt")).toBeNull()
    expect(needsRefresh(token(NOW + 600), NOW)).toBe(false)
    expect(needsRefresh(token(NOW + 30), NOW)).toBe(true)
    expect(needsRefresh(undefined, NOW)).toBe(true)
    expect(needsRefresh("garbage.garbage.garbage", NOW)).toBe(true)
  })
})

describe("decideRoute on app.", () => {
  it("sends / to the picker or to login", () => {
    expect(route("app.lvh.me:3001", "/", { pg_id: "i" })).toEqual({ kind: "redirect", to: "/workspaces" })
    expect(route("app.lvh.me:3001", "/")).toEqual({ kind: "redirect", to: "/login" })
  })

  it("serves the public pages to anyone and the picker only with an identity", () => {
    expect(route("app.lvh.me:3001", "/login")).toEqual({ kind: "next", slug: null })
    expect(route("app.lvh.me:3001", "/invite?token=t")).toEqual({ kind: "next", slug: null })
    expect(route("app.lvh.me:3001", "/workspaces")).toEqual({ kind: "redirect", to: "/login?next=%2Fworkspaces" })
    expect(route("app.lvh.me:3001", "/new", { pg_id: "i" })).toEqual({ kind: "next", slug: null })
  })

  it("has no workspace pages", () => {
    expect(route("app.lvh.me:3001", "/tickets", { pg_id: "i" })).toEqual({ kind: "not-found" })
  })
})

describe("decideRoute on a workspace", () => {
  const fresh = { pg_at_acme: token(NOW + 600), pg_id: "i" }

  it("serves a page with a fresh token, naming the slug", () => {
    expect(route("acme.lvh.me:3001", "/tickets", fresh)).toEqual({ kind: "next", slug: "acme" })
  })

  it("refreshes first when the token is missing or about to lapse, and there is an identity", () => {
    expect(route("acme.lvh.me:3001", "/tickets?status=open", { pg_id: "i" })).toEqual({
      kind: "redirect",
      to: "/session/refresh?next=%2Ftickets%3Fstatus%3Dopen",
    })
    expect(route("acme.lvh.me:3001", "/queues", { pg_at_acme: token(NOW + 10), pg_id: "i" })).toEqual({
      kind: "redirect",
      to: "/session/refresh?next=%2Fqueues",
    })
  })

  it("sends a browser with no session at all to login on app., with the way back", () => {
    expect(route("acme.lvh.me:3001", "/tickets")).toEqual({
      kind: "redirect",
      to: `${APP}/login?next=${encodeURIComponent("http://acme.lvh.me:3001/tickets")}`,
    })
  })

  it("lets the refresh page through without a token", () => {
    expect(route("acme.lvh.me:3001", "/session/refresh?next=%2F")).toEqual({ kind: "next", slug: "acme" })
  })

  it("never reads another workspace's cookie as this one's", () => {
    expect(route("acme.lvh.me:3001", "/tickets", { pg_at_globex: token(NOW + 600), pg_id: "i" })).toEqual({
      kind: "redirect",
      to: "/session/refresh?next=%2Ftickets",
    })
  })

  it("sends tenant-less pages to app.", () => {
    expect(route("acme.lvh.me:3001", "/login?next=x", fresh)).toEqual({ kind: "redirect", to: `${APP}/login?next=x` })
  })

  it("serves nothing for a host that is not ours", () => {
    expect(route("api.lvh.me:3001", "/tickets", fresh)).toEqual({ kind: "not-found" })
  })
})
