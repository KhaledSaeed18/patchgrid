import "reflect-metadata"

import { NestFactory } from "@nestjs/core"
import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import type { NestExpressApplication } from "@nestjs/platform-express"
import helmet from "helmet"
import { Logger } from "nestjs-pino"

import { AppModule } from "./app.module"
import { corsOriginCallback } from "./common/http/origin-policy"
import { APP_CONFIG, type AppConfig } from "./config/app-config"

/**
 * The order below is the request pipeline from `ARCHITECTURE.md`, and it is
 * load-bearing rather than incidental — the cheapest defence runs first, and the
 * tenant is resolved from the credential rather than the host (ADR-0024).
 */
/**
 * The repository root `.env` is the local development source of variables. Node
 * 24 loads it natively, so no dotenv dependency. In every other environment the
 * variables are supplied directly and a missing file is not an error — the Zod
 * schema is what decides whether the configuration is complete.
 *
 * The file is found by walking *up* rather than by a fixed `../../..`: that
 * relative path only works because `src/` and `dist/` happen to sit at the same
 * depth, which is the kind of coincidence that breaks in a container and takes
 * an afternoon to diagnose. `ENV_FILE` overrides the search entirely.
 */
function loadLocalEnv(): void {
  const explicit = process.env.ENV_FILE
  const candidates: string[] = []

  if (explicit !== undefined && explicit !== "") {
    candidates.push(path.resolve(explicit))
  } else {
    // `__dirname`, not `import.meta.dirname`: this app compiles to CommonJS, and
    // `import.meta` is not available there.
    let directory = __dirname
    for (let depth = 0; depth < 6; depth += 1) {
      candidates.push(path.join(directory, ".env"))
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) return

  try {
    process.loadEnvFile(found)
  } catch {
    // unreadable or malformed — the Zod schema reports what is missing
  }
}

async function bootstrap(): Promise<void> {
  loadLocalEnv()

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffer startup logs until the pino logger exists, so boot failures are
    // formatted like everything else instead of being raw console output.
    bufferLogs: true,
  })

  app.useLogger(app.get(Logger))
  app.flushLogs()

  const config = app.get<AppConfig>(APP_CONFIG)

  app.use(
    helmet({
      // This process serves JSON, not documents. A content-security policy for
      // HTML would be cargo cult; the headers that matter for an API are the
      // rest of the set.
      contentSecurityPolicy: false,
      // CORP would block the cross-origin reads that the tenant subdomains make
      // on purpose; CORS is the mechanism that governs those (below).
      crossOriginResourcePolicy: false,
    }),
  )

  app.enableCors({
    origin: corsOriginCallback({
      rootDomain: config.ROOT_DOMAIN,
      allowHttp: !config.isProduction,
      allowedPorts: config.WEB_ORIGIN_PORTS,
    }),
    // Cookies are the session mechanism, so credentialed requests are the norm.
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "X-Patchgrid-Tenant", "Idempotency-Key"],
    exposedHeaders: ["X-Request-Id"],
    maxAge: 600,
  })

  // Health lives outside the version prefix so orchestrators find it where they
  // expect, and so a future /api/v2 does not move it.
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })

  if (config.isProduction) {
    // Behind a reverse proxy the client IP arrives in X-Forwarded-For. Rate
    // limiting keyed on the proxy's own address would be worse than none at all.
    app.set("trust proxy", 1)
  }

  // Lets Prisma and Redis close their connections on SIGTERM rather than having
  // them severed mid-query.
  app.enableShutdownHooks()

  await app.listen(config.PORT, "0.0.0.0")

  const logger = app.get(Logger)
  logger.log(
    `api listening on http://api.${config.ROOT_DOMAIN}:${String(config.PORT)} ` +
      `(${config.NODE_ENV}, root domain ${config.ROOT_DOMAIN})`,
  )
}

void bootstrap()
