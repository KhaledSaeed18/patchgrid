import "reflect-metadata"

import { NestFactory } from "@nestjs/core"
import type { NestExpressApplication } from "@nestjs/platform-express"
import helmet from "helmet"
import { Logger } from "nestjs-pino"

import { AppModule } from "./app.module"
import { INBOUND_WEBHOOK_PATH, inboundBodyParser } from "./inbound/inbound.controller"
import { corsOriginCallback, originPolicyFrom } from "./common/http/origin-policy"
import { APP_CONFIG, type AppConfig } from "./config/app-config"
import { serveOpenApi } from "./openapi"

/**
 * The order below is the request pipeline from `ARCHITECTURE.md`, and it is
 * load-bearing rather than incidental — the cheapest defence runs first, and the
 * tenant is resolved from the credential rather than the host (ADR-0024).
 * Loaded by `main.ts` once the environment and telemetry are in place.
 */
export async function bootstrap(): Promise<void> {
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
      // This process serves JSON, not documents. The policy is the strictest
      // one there is — nothing may load, nothing may frame it — so a response
      // that is ever rendered as a document by mistake stays inert. The
      // headers that matter for an API are the rest of the set.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      // CORP would block the cross-origin reads that the tenant subdomains make
      // on purpose; CORS is the mechanism that governs those (below).
      crossOriginResourcePolicy: false,
    }),
  )

  app.enableCors({
    origin: corsOriginCallback(originPolicyFrom(config)),
    // Cookies are the session mechanism, so credentialed requests are the norm.
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "X-Patchgrid-Tenant", "X-Patchgrid-Surface", "Idempotency-Key"],
    exposedHeaders: ["X-Request-Id"],
    maxAge: 600,
  })

  // The inbound webhook is signed over its bytes (ADR-0039): they are kept raw, ahead of Nest's JSON parser.
  app.use(INBOUND_WEBHOOK_PATH, inboundBodyParser())
  // Health lives outside the version prefix so orchestrators find it where they
  // expect, and so a future /api/v2 does not move it.
  app.setGlobalPrefix("api/v1", { exclude: ["health", "health/ready"] })

  if (config.isProduction) {
    // Behind a reverse proxy the client IP arrives in X-Forwarded-For. Rate
    // limiting keyed on the proxy's own address would be worse than none at all.
    app.set("trust proxy", 1)
  }

  // The reference, generated from the same Zod contracts the pipes enforce (ENGINEERING.md §API conventions).
  serveOpenApi(app, config)

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
