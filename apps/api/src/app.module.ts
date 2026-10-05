import { Module } from "@nestjs/common"
import { APP_FILTER, APP_PIPE } from "@nestjs/core"
import { LoggerModule } from "nestjs-pino"
import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"

import { CommonModule } from "./common/common.module"
import { ProblemDetailsFilter } from "./common/problems/problem-details.filter"
import { ZodValidationPipe } from "./common/problems/zod-validation.pipe"
import { AuthModule } from "./auth/auth.module"
import { APP_CONFIG, type AppConfig } from "./config/app-config"
import { ConfigModule } from "./config/config.module"
import { HealthModule } from "./health/health.module"
import { JobsModule } from "./jobs/jobs.module"
import { MailModule } from "./mail/mail.module"
import { OrgsModule } from "./orgs/orgs.module"
import { PrismaModule } from "./prisma/prisma.module"
import { RedisModule } from "./redis/redis.module"
import { TenantContextService } from "./tenancy/tenant-context.service"
import { TenancyModule } from "./tenancy/tenancy.module"
import { ThrottlingModule } from "./throttling/throttling.module"

@Module({
  imports: [
    ConfigModule,
    CommonModule,
    LoggerModule.forRootAsync({
      imports: [TenancyModule],
      inject: [APP_CONFIG, TenantContextService],
      useFactory: (config: AppConfig, tenantContext: TenantContextService) => ({
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
           * answerable question (`ENGINEERING.md` §Logging). pino-http evaluates
           * this twice — when the request arrives, before any tenant is known,
           * and again when the response finishes, inside the request context —
           * so the completion line carries the tenant that resolution settled on.
           */
          customProps: () => {
            const orgId = tenantContext.current()?.orgId
            return orgId === undefined ? {} : { orgId }
          },

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
    // Order matters: the per-IP throttler guard registers before the tenant
    // resolution guard (pipeline steps 3 then 4).
    ThrottlingModule,
    TenancyModule,
    PrismaModule,
    RedisModule,
    AuthModule,
    JobsModule,
    MailModule,
    OrgsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule {}
