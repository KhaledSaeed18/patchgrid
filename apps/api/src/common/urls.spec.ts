import { describe, expect, it } from "vitest"

import type { AppConfig } from "../config/app-config"
import { PublicUrls } from "./urls"

describe("PublicUrls", () => {
  it("uses http and ports in development", () => {
    const urls = new PublicUrls({ ROOT_DOMAIN: "lvh.me", WEB_ORIGIN_PORTS: [3000, 3001], WEB_APP_PORT: 3001, isProduction: false } as AppConfig)
    expect(urls.marketing()).toBe("http://lvh.me:3000")
    expect(urls.app("/verify?token=x")).toBe("http://app.lvh.me:3001/verify?token=x")
    expect(urls.workspace("acme")).toBe("http://acme.lvh.me:3001/")
  })

  it("uses https and no port in production", () => {
    const urls = new PublicUrls({ ROOT_DOMAIN: "patchgrid.xyz", WEB_ORIGIN_PORTS: [] as number[], WEB_APP_PORT: 3001, isProduction: true } as AppConfig)
    expect(urls.marketing()).toBe("https://patchgrid.xyz")
    expect(urls.workspace("acme", "/tickets/1")).toBe("https://acme.patchgrid.xyz/tickets/1")
  })
})
