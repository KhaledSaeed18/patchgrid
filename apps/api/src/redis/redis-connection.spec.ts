import { describe, expect, it } from "vitest"

import { redisConnectionOptions } from "./redis-connection"

describe("redisConnectionOptions", () => {
  it("parses the local default", () => {
    expect(redisConnectionOptions("redis://localhost:6379")).toEqual({ host: "localhost", port: 6379 })
  })

  it("parses credentials, database and TLS", () => {
    expect(redisConnectionOptions("rediss://user:p%40ss@cache.example:6380/2")).toEqual({
      host: "cache.example",
      port: 6380,
      username: "user",
      password: "p@ss",
      db: 2,
      tls: {},
    })
  })

  it("refuses a URL that is not Redis", () => {
    expect(() => redisConnectionOptions("http://localhost")).toThrow(/redis:/)
  })
})
