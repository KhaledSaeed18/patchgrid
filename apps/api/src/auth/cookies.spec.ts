import type { Response } from "express"
import { describe, expect, it } from "vitest"

import type { AppConfig } from "../config/app-config"
import { CookieService } from "./cookies"

const config = { COOKIE_DOMAIN: ".lvh.me", isProduction: false, ACCESS_TOKEN_TTL_SECONDS: 900, REFRESH_TOKEN_TTL_DAYS: 7 } as AppConfig

/** A response that records what was set and cleared, over a request carrying `cookie`. */
function exchange(cookie?: string) {
  const set = new Map<string, string>()
  const cleared: string[] = []
  const response = {
    req: { headers: cookie === undefined ? {} : { cookie } },
    cookie: (name: string, value: string) => void set.set(name, value),
    clearCookie: (name: string) => void cleared.push(name),
  }
  return { response: response as unknown as Response, set, cleared }
}

const cookies = new CookieService(config)
const mint = (slug: string) => [cookies.access(slug, "at"), cookies.refresh(slug, "rt")]

describe("CookieService — the five-pair budget", () => {
  it("puts a minted workspace at the front of the browser's list", () => {
    const x = exchange("pg_ws=acme.globex")
    cookies.set(x.response, mint("initech"))
    expect(x.set.get("pg_ws")).toBe("initech.acme.globex")
    expect(x.cleared).toEqual([])
  })

  it("moves a refreshed workspace forward rather than listing it twice", () => {
    const x = exchange("pg_ws=acme.globex.initech")
    cookies.set(x.response, mint("initech"))
    expect(x.set.get("pg_ws")).toBe("initech.acme.globex")
  })

  it("expires the least recently used pairs past five", () => {
    const x = exchange("pg_ws=a01.a02.a03.a04.a05")
    cookies.set(x.response, mint("a06"))
    expect(x.set.get("pg_ws")).toBe("a06.a01.a02.a03.a04")
    expect(x.cleared).toEqual(["pg_at_a05", "pg_rt_a05"])
  })

  it("counts pairs minted before the list existed, as the oldest", () => {
    const x = exchange("pg_rt_old=1; pg_at_new=2; pg_ws=a01.a02.a03.a04; pg_id=3")
    cookies.set(x.response, mint("a05"))
    expect(x.set.get("pg_ws")).toBe("a05.a01.a02.a03.a04")
    expect(x.cleared).toEqual(["pg_at_old", "pg_rt_old", "pg_at_new", "pg_rt_new"])
  })

  it("drops a cleared workspace from the list, and composes with a set in the same response", () => {
    const x = exchange("pg_ws=acme.globex")
    // A slug change: the new name minted, the old one expired.
    cookies.set(x.response, mint("acme-corp"))
    cookies.clear(x.response, cookies.pairOf("acme"))
    expect(x.set.get("pg_ws")).toBe("acme-corp.globex")
  })

  it("ignores anything in the list that could not be a slug", () => {
    const x = exchange("pg_ws=acme.UPPER.-bad..x;globex")
    cookies.set(x.response, mint("initech"))
    expect(x.set.get("pg_ws")).toBe("initech.acme")
  })

  it("leaves the list alone when no pair is set", () => {
    const x = exchange("pg_ws=acme")
    cookies.set(x.response, [cookies.identity("id")])
    expect(x.set.has("pg_ws")).toBe(false)
  })
})
