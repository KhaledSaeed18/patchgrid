import { Controller, Get, type INestApplication, Post } from "@nestjs/common"
import { APP_FILTER, APP_GUARD } from "@nestjs/core"
import { Test } from "@nestjs/testing"
import { Throttle, ThrottlerModule } from "@nestjs/throttler"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ProblemDetailsFilter } from "../common/problems/problem-details.filter"
import { APP_CONFIG, type AppConfig } from "../config/app-config"
import { IpThrottlerGuard } from "./throttler.guards"
import { SkipAllThrottling, THROTTLERS } from "./throttlers"

@Controller("probe")
class ProbeController {
  @Get()
  @Throttle({ ip: { limit: 2, ttl: 60_000 } })
  tight() {
    return { ok: true }
  }

  @Get("open")
  open() {
    return { ok: true }
  }

  @Get("health")
  @SkipAllThrottling()
  health() {
    return { ok: true }
  }

  @Post("identity")
  @Throttle({ ip: { limit: 100, ttl: 60_000 }, email: { limit: 2, ttl: 60_000 } })
  identity() {
    return { accepted: true }
  }
}

async function boot(enabled: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    // In-memory storage: the Redis storage has its own spec against a live Redis.
    imports: [ThrottlerModule.forRoot({ throttlers: THROTTLERS })],
    controllers: [ProbeController],
    providers: [
      { provide: APP_CONFIG, useValue: { THROTTLE_ENABLED: enabled } as AppConfig },
      { provide: APP_GUARD, useClass: IpThrottlerGuard },
      { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await app.init()
  return app
}

let app: INestApplication
let disabled: INestApplication

beforeAll(async () => {
  app = await boot(true)
  disabled = await boot(false)
})

afterAll(async () => {
  await Promise.all([app.close(), disabled.close()])
})

describe("per-IP throttling (pipeline step 3)", () => {
  it("answers 429 as Problem Details with Retry-After once a route's limit is hit", async () => {
    const http = request(app.getHttpServer())
    expect((await http.get("/probe")).status).toBe(200)
    const second = await http.get("/probe")
    expect(second.status).toBe(200)
    expect(second.headers["x-ratelimit-remaining-ip"]).toBe("0")

    const third = await http.get("/probe")
    expect(third.status).toBe(429)
    expect(third.headers["content-type"]).toContain("application/problem+json")
    expect(third.body.type).toBe("https://patchgrid.xyz/problems/rate-limited")
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0)
    expect(third.body.detail).toMatch(/Retry in \d+ seconds/)
  })

  it("leaves the generous default on other routes and skips health", async () => {
    const http = request(app.getHttpServer())
    for (let i = 0; i < 5; i += 1) expect((await http.get("/probe/open")).status).toBe(200)
    for (let i = 0; i < 5; i += 1) expect((await http.get("/probe/health")).status).toBe(200)
    expect((await http.get("/probe/health")).headers["x-ratelimit-limit-ip"]).toBeUndefined()
  })

  it("counts identity requests per address named, not per sender", async () => {
    const http = request(app.getHttpServer())
    const send = (email: string) => http.post("/probe/identity").send({ email })
    expect((await send("Victim@Acme.test")).status).toBe(201)
    expect((await send("victim@acme.test")).status).toBe(201)
    expect((await send("victim@acme.test")).status).toBe(429)
    // Another address is a separate budget; a body without one is not counted here.
    expect((await send("someone-else@acme.test")).status).toBe(201)
    expect((await http.post("/probe/identity").send({})).status).toBe(201)
  })

  it("does nothing when disabled for a test environment", async () => {
    const http = request(disabled.getHttpServer())
    for (let i = 0; i < 5; i += 1) expect((await http.get("/probe")).status).toBe(200)
  })
})
