import { Module } from "@nestjs/common"
import { APP_FILTER, APP_PIPE } from "@nestjs/core"
import { LoggerModule } from "nestjs-pino"
import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"

import { CLOCK, SystemClock } from "./common/clock/clock"
import { ProblemDetailsFilter } from "./common/problems/problem-details.filter"
import { ZodValidationPipe } from "./common/problems/zod-validation.pipe"
import { NoopTracer, TRACER } from "./common/tracing/tracer"
import { APP_CONFIG, type AppConfig } from "./config/app-config"
import { ConfigModule } from "./config/config.module"
import { HealthModule } from "./health/health.module"
import { PrismaModule } from "./prisma/prisma.module"
import { RedisModule } from "./redis/redis.module"

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.LOG_LEVEL,
          // Pretty locally, JSON everywhere else — a log you cannot read during
          // development is a log nobody looks at.
          ...(config.isProduction
            ? {}
            : { transport: { target: "pino-pretty", options: { singleLine: true } } }),

          /**
           * One id per request, threaded through every log line and returned as
           * `correlationId` on 5xx responses (ADR-0012). An id supplied by an
           * upstream proxy is honoured so a trace survives the hop.
           */
          genReqId: (req: IncomingMessage, res: ServerResponse): string => {
            const forwarded = req.headers["x-request-id"]
            const id = typeof forwarded === "string" && forwarded !== "" ? forwarded : randomUUID()
            res.setHeader("x-request-id", id)
            return id
          },

          /**
           * `orgId` on every line is what makes "which tenant is slow" an
           * answerable question (`ENGINEERING.md` §Logging). It is populated from
           * the request context in M1; the field exists now so the shape of a log
           * line does not change under anyone later.
           */
          customProps: () => ({}),

          // No PII, ever. Never emails, ticket bodies or credentials.
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.headers['x-patchgrid-tenant']",
              "res.headers['set-cookie']",
            ],
            remove: true,
          },

          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },

          // Health probes fire every few seconds. Logging them drowns everything
          // that matters, and a readiness failure is reported by the probe itself.
          autoLogging: {
            ignore: (req: IncomingMessage) => req.url?.startsWith("/health") === true,
          },
        },
      }),
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
  ],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: TRACER, useClass: NoopTracer },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
  exports: [CLOCK, TRACER],
})
export class AppModule {}
