import { describe, expect, it } from "vitest"

import { envSchema } from "./env.schema"

const valid = {
  DATABASE_URL: "postgresql://patchgrid_app:app@localhost:5432/patchgrid",
  DATABASE_MIGRATION_URL: "postgresql://patchgrid_owner:owner@localhost:5432/patchgrid",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "patchgrid-attachments",
  S3_ACCESS_KEY_ID: "patchgrid",
  S3_SECRET_ACCESS_KEY: "patchgrid-local-dev",
  JWT_SECRET: "local-development-secret-that-is-at-least-32-chars",
  INBOUND_WEBHOOK_SECRET: "whsec_cGF0Y2hncmlkLWxvY2FsLWluYm91bmQtc2VjcmV0",
  INBOUND_AUTHSERV_ID: "mx.inbound.lvh.me",
  MFA_ENCRYPTION_KEY: "cGF0Y2hncmlkLWxvY2FsLW1mYS1rZXktMzJieXRlcyE=",
}

const issues = (overrides: Record<string, string>) => {
  const result = envSchema.safeParse({ ...valid, ...overrides })
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))
}

describe("envSchema", () => {
  it("accepts the documented local environment with its defaults", () => {
    const parsed = envSchema.parse(valid)
    expect(parsed.ACCESS_TOKEN_TTL_SECONDS).toBe(900)
    expect(parsed.REFRESH_TOKEN_TTL_DAYS).toBe(7)
    expect(parsed.COOKIE_DOMAIN).toBe(".lvh.me")
  })

  it("trusts one proxy hop unless told otherwise, and never an unbounded chain", () => {
    expect(envSchema.parse(valid).TRUST_PROXY_HOPS).toBe(1)
    expect(envSchema.parse({ ...valid, TRUST_PROXY_HOPS: "2" }).TRUST_PROXY_HOPS).toBe(2)
    expect(issues({ TRUST_PROXY_HOPS: "-1" })).toContain("TRUST_PROXY_HOPS")
    expect(issues({ TRUST_PROXY_HOPS: "true" })).toContain("TRUST_PROXY_HOPS")
  })

  it("refuses to run the application as the migration role", () => {
    expect(issues({ DATABASE_MIGRATION_URL: valid.DATABASE_URL })).toContain("DATABASE_URL")
  })

  it("refuses a signing secret an attacker could brute-force", () => {
    expect(issues({ JWT_SECRET: "short" })).toContain("JWT_SECRET")
  })

  it("refuses a cookie domain the api host could not read", () => {
    expect(issues({ COOKIE_DOMAIN: "lvh.me" })).toContain("COOKIE_DOMAIN")
    expect(issues({ COOKIE_DOMAIN: ".patchgrid.xyz" })).toContain("COOKIE_DOMAIN")
    expect(issues({ ROOT_DOMAIN: "patchgrid.xyz", COOKIE_DOMAIN: ".patchgrid.xyz" })).toEqual([])
  })

  it("keeps mail links on an origin CORS accepts, and the sender well-formed", () => {
    expect(issues({ WEB_APP_PORT: "4444" })).toContain("WEB_APP_PORT")
    expect(issues({ MAIL_FROM: "notifications@patchgrid.test" })).toContain("MAIL_FROM")
    expect(envSchema.parse(valid).WORKER_MODE).toBe("all")
    expect(envSchema.parse(valid).THROTTLE_ENABLED).toBe(true)
    expect(envSchema.parse({ ...valid, THROTTLE_ENABLED: "false" }).THROTTLE_ENABLED).toBe(false)
    expect(issues({ THROTTLE_ENABLED: "0" })).toContain("THROTTLE_ENABLED")
  })

  it("refuses ports on production origins", () => {
    expect(issues({ NODE_ENV: "production" })).toContain("WEB_ORIGIN_PORTS")
    expect(issues({ NODE_ENV: "production", WEB_ORIGIN_PORTS: "" })).toEqual([])
  })
})

describe("the attachments origin (ADR-0037)", () => {
  it("defaults to MinIO on localhost, its own site", () => {
    expect(envSchema.parse(valid).FILES_PUBLIC_ORIGIN).toBe("http://localhost:9000")
  })

  it("refuses an origin under the root domain — every session would reach it", () => {
    expect(issues({ FILES_PUBLIC_ORIGIN: "http://files.lvh.me:9000" })).toContain("FILES_PUBLIC_ORIGIN")
    expect(issues({ FILES_PUBLIC_ORIGIN: "http://lvh.me:9000" })).toContain("FILES_PUBLIC_ORIGIN")
    expect(issues({ FILES_PUBLIC_ORIGIN: "https://patchgrid-files.net" })).not.toContain("FILES_PUBLIC_ORIGIN")
  })
})
