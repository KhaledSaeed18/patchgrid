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

  it("refuses ports on production origins", () => {
    expect(issues({ NODE_ENV: "production" })).toContain("WEB_ORIGIN_PORTS")
    expect(issues({ NODE_ENV: "production", WEB_ORIGIN_PORTS: "" })).toEqual([])
  })
})
