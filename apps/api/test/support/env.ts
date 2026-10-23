/**
 * Loads the repository `.env` for integration specs that boot the real
 * AppModule. In CI the variables come from the job; anything only the API
 * needs and the job does not set gets a harmless default here.
 */
import path from "node:path"
import process from "node:process"

try {
  process.loadEnvFile(path.join(__dirname, "../../../../.env"))
} catch {
  // variables come from the environment
}

const defaults: Record<string, string> = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  // The lifecycle specs drive one endpoint dozens of times from one address.
  THROTTLE_ENABLED: "false",
  JWT_SECRET: "integration-test-secret-that-is-at-least-32-chars",
  REDIS_URL: "redis://localhost:6379",
  // docker-compose.yml's MinIO, as CI starts it with no .env: the attachment specs PUT real bytes.
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "patchgrid-attachments",
  S3_ACCESS_KEY_ID: "patchgrid",
  S3_SECRET_ACCESS_KEY: "patchgrid-local-dev",
  INBOUND_WEBHOOK_SECRET: "whsec_cGF0Y2hncmlkLWxvY2FsLWluYm91bmQtc2VjcmV0",
  INBOUND_AUTHSERV_ID: "mx.inbound.lvh.me",
  MFA_ENCRYPTION_KEY: "cGF0Y2hncmlkLWxvY2FsLW1mYS1rZXktMzJieXRlcyE=",
  WEBHOOK_SECRETS_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  SSO_SECRETS_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
}
for (const [name, value] of Object.entries(defaults)) {
  if (process.env[name] === undefined || process.env[name] === "") process.env[name] = value
}

// Specs get their own Redis database. A `pnpm dev` API on the same Redis is
// another worker on the same queues, and would take the mail jobs a spec is
// waiting for; idempotency keys and throttle counters would mix too.
const redis = new URL(process.env.REDIS_URL ?? defaults.REDIS_URL ?? "")
redis.pathname = "/1"
process.env.REDIS_URL = redis.toString()

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is required`)
  return value
}
