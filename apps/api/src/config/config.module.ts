import { Global, Module } from "@nestjs/common"

import { APP_CONFIG, toAppConfig, type AppConfig } from "./app-config"
import { envSchema } from "./env.schema"

/**
 * Parses and validates the environment exactly once, at module construction —
 * which is before any controller, provider or database connection exists. A
 * failure here is a failed boot, not a runtime surprise.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source)

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n")
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }

  return toAppConfig(parsed.data)
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
