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
  JWT_SECRET: "integration-test-secret-that-is-at-least-32-chars",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "patchgrid-attachments",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
}
for (const [name, value] of Object.entries(defaults)) {
  if (process.env[name] === undefined || process.env[name] === "") process.env[name] = value
}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is required`)
  return value
}
